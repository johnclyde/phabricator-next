import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { RevisionDetail } from '../shared/types';

async function create(request: APIRequestContext, baseURL: string) {
  const response = await request.post(new URL('api/revisions', baseURL).href, { data: { kind: 'document', title: `Retained source ${Date.now()}`, testPlan: 'Preserve independent tab drafts and exact source.', files: [{ path: 'motion.md', content: 'Original argument.\nOriginal evidence.\n' }] } });
  expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<RevisionDetail>;
}
async function editor(page: Page, id: string) { await page.goto(`./#${id}`); await page.getByRole('button', { name: 'Edit & add version', exact: true }).click(); }
async function retained(page: Page, key: string) { return page.evaluate(key => { const stored = Object.keys(localStorage).find(item => item.endsWith(`:${key}`)); return stored ? JSON.parse(localStorage.getItem(stored)!) as unknown : null; }, key); }

test('each tab recovers its own version draft after competing edits and route changes', async ({ page, context, request, baseURL }, info) => {
  const detail = await create(request, baseURL!), id = detail.revision.id, key = `version-draft:${id}:1`;
  const other = await context.newPage();
  try {
    await editor(page, id); await editor(other, id);
    await page.getByRole('textbox', { name: 'File content', exact: true }).fill('First tab source.');
    await page.getByLabel('What changed?', { exact: true }).fill('First tab message.');
    await expect.poll(() => retained(page, key)).toMatchObject({ files: [{ path: 'motion.md', content: 'First tab source.' }], message: 'First tab message.' });
    await other.getByRole('textbox', { name: 'File content', exact: true }).fill('Second tab source.');
    await other.getByLabel('What changed?', { exact: true }).fill('Second tab message.');
    await expect(other.getByRole('textbox', { name: 'File content', exact: true })).toHaveValue('Second tab source.');
    await page.goto('./#home'); await other.goto('./#home');
    await editor(page, id); await editor(other, id);
    await expect(page.getByRole('textbox', { name: 'File content', exact: true })).toHaveValue('First tab source.');
    await expect(page.getByLabel('What changed?', { exact: true })).toHaveValue('First tab message.');
    await expect(other.getByRole('textbox', { name: 'File content', exact: true })).toHaveValue('Second tab source.');
    await expect(other.getByLabel('What changed?', { exact: true })).toHaveValue('Second tab message.');
    await expect(other.getByRole('button', { name: 'Export Draft', exact: true })).toBeVisible();
    const warning = other.locator('.version-editor > p').first(); await expect(warning).toContainText('only in this tab'); await warning.scrollIntoViewIfNeeded();
    expect(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await other.screenshot({ path: info.outputPath('version-draft-conflict.png') });
    await expect.poll(() => retained(page, key)).toMatchObject({ files: [{ path: 'motion.md', content: 'First tab source.' }] });
  } finally { await other.close(); }
});

test('competing comments retain their original source and a submitted comment permits another draft', async ({ page, context, request, baseURL }) => {
  const detail = await create(request, baseURL!), id = detail.revision.id, key = `comment-source:${id}:${detail.versions[0]!.id}`;
  const other = await context.newPage();
  try {
    for (const tab of [page, other]) { await tab.goto(`./#${id}`); await tab.getByRole('button', { name: 'Source', exact: true }).click(); }
    await page.getByRole('button', { name: 'Comment on line 1', exact: true }).click();
    await page.getByLabel('Review comment', { exact: true }).fill('First tab comment.');
    await expect.poll(() => retained(page, key)).toMatchObject({ body: 'First tab comment.', line: 1 });
    await other.getByRole('button', { name: 'Comment on line 2', exact: true }).click();
    await other.getByLabel('Review comment', { exact: true }).fill('Second tab comment.');
    await page.goto('./#home'); await other.goto('./#home');
    for (const tab of [page, other]) await tab.goto(`./#${id}`);
    await expect(page.getByLabel('Review comment', { exact: true })).toHaveValue('First tab comment.');
    await expect(page.locator('.comment-target')).toContainText('motion.md:1');
    await expect(other.getByLabel('Review comment', { exact: true })).toHaveValue('Second tab comment.');
    await expect(other.locator('.comment-target')).toContainText('motion.md:2');
    await page.getByRole('button', { name: 'Add Comment', exact: true }).click();
    await expect(page.getByLabel('Review comment', { exact: true })).toHaveValue('');
    await page.getByLabel('Review comment', { exact: true }).fill('Next comment after acknowledged cleanup.');
    await expect.poll(() => retained(page, key)).toMatchObject({ body: 'Next comment after acknowledged cleanup.' });
    await other.goto('./#home'); await other.goto(`./#${id}`);
    await expect(other.getByLabel('Review comment', { exact: true })).toHaveValue('Second tab comment.');
    await expect(other.locator('.comment-target')).toContainText('motion.md:2');
  } finally { await other.close(); }
});

test('closing creation dialogs keeps competing tab drafts separate', async ({ page, context }, info) => {
  const other = await context.newPage();
  const open = async (tab: Page) => { await tab.goto('./#tasks'); await tab.getByRole('button', { name: 'Create Task', exact: true }).click(); };
  try {
    await open(page); await open(other);
    await page.getByRole('dialog').getByLabel('Title', { exact: true }).fill('First tab task draft.');
    await expect.poll(() => retained(page, 'draft:task:new')).toMatchObject({ title: 'First tab task draft.' });
    await other.getByRole('dialog').getByLabel('Title', { exact: true }).fill('Second tab task draft.');
    for (const tab of [page, other]) { await tab.getByRole('button', { name: 'Close dialog', exact: true }).click(); await tab.goto('./#home'); await open(tab); }
    await expect(page.getByRole('dialog').getByLabel('Title', { exact: true })).toHaveValue('First tab task draft.');
    await expect(other.getByRole('dialog').getByLabel('Title', { exact: true })).toHaveValue('Second tab task draft.');
    await expect(other.getByRole('dialog').getByText('This draft is only in this tab. Keep it open or export it.', { exact: true })).toBeVisible();
    expect(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await other.screenshot({ path: info.outputPath('create-draft-conflict.png') });
    await expect.poll(() => retained(page, 'draft:task:new')).toMatchObject({ title: 'First tab task draft.' });
  } finally { await other.close(); }
});

test('a normalized legacy version draft can save unchanged and clear its exact retained copy', async ({ page, request, baseURL }) => {
  const detail = await create(request, baseURL!), id = detail.revision.id, key = `version-draft:${id}:1`;
  await page.goto(`./#${id}`); await expect(page.getByLabel('Version to inspect', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(item => item.endsWith(':state')))).toBe(true);
  await page.evaluate(({ key }) => {
    const state = Object.keys(localStorage).find(item => item.endsWith(':state'));
    if (!state) throw new Error('Authorized workspace fixture is not cached.');
    localStorage.setItem(`${state.slice(0, -'state'.length)}${key}`, JSON.stringify({ files: [{ path: 'motion.md', content: 'Legacy retained source.' }], message: 'Previously typed version message.' }));
  }, { key });
  await page.getByRole('button', { name: 'Edit & add version', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'File content', exact: true })).toHaveValue('Legacy retained source.');
  await page.getByRole('button', { name: 'Save New Version', exact: true }).click();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
  await expect.poll(() => retained(page, key)).toBeNull();
});

test('a delayed source import keeps later typed source and requires an explicit reselection', async ({ page }) => {
  await page.goto('./#drafts'); await page.getByRole('button', { name: 'Create Draft', exact: true }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title', { exact: true }).fill('Source import retirement.');
  await dialog.getByLabel('Test Plan', { exact: true }).fill('Preserve the latest chosen source.');
  const source = dialog.getByRole('textbox', { name: /^Draft text/ });
  await source.fill('Original editor text.');
  await page.evaluate(() => {
    const original = File.prototype.text; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    (window as unknown as { releaseSource: () => void }).releaseSource = release;
    File.prototype.text = async function () { const result = await original.call(this); await gate; return result; };
  });
  const file = { name: 'imported.md', mimeType: 'text/plain', buffer: Buffer.from('Imported exact source.\n') };
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await expect(dialog.getByRole('button', { name: 'Create Draft', exact: true })).toBeDisabled();
  await source.fill('Later typed source must survive.');
  await page.evaluate(() => (window as unknown as { releaseSource: () => void }).releaseSource());
  await expect(dialog.getByRole('alert')).toContainText('Your current source was kept. Select the file again');
  await expect(source).toHaveValue('Later typed source must survive.');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Create Draft', exact: true }).click();
  await expect(source).toHaveValue('Later typed source must survive.');
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await expect(source).toHaveValue('Imported exact source.\n');
  await expect(dialog.getByRole('textbox', { name: 'Source file path', exact: true })).toHaveValue('imported.md');
});

test('a held comment writer reports tab-only retention until its exact bytes are durable', async ({ page, request, baseURL }) => {
  const detail = await create(request, baseURL!), id = detail.revision.id, versionId = detail.versions[0]!.id, key = `comment-source:${id}:${versionId}`;
  await page.goto(`./#${id}`); await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByRole('button', { name: 'Comment on line 1', exact: true }).click();
  await expect.poll(() => retained(page, key)).toEqual({ body: '', versionId, filePath: 'motion.md', line: 1 });
  await page.evaluate(async key => {
    const saved = Object.keys(localStorage).find(item => item.endsWith(`:${key}`));
    if (!saved) throw new Error('Expected the exact empty anchored draft.');
    const lock = `${saved.slice(0, -key.length)}file-intent:${key}`;
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    (window as unknown as { releaseCommentWriter: () => void }).releaseCommentWriter = release;
    await new Promise<void>((resolve, reject) => { void navigator.locks.request(lock, async () => { resolve(); await hold; }).catch(reject); });
  }, key);
  try {
    await page.getByLabel('Review comment', { exact: true }).fill('Still waiting for the retained writer.');
    const form = page.locator('.comment-form');
    await expect(form).toContainText('This comment draft is only in this tab. Keep it open or export it.');
    await expect(form.getByRole('button', { name: 'Export Draft', exact: true })).toBeVisible();
    await expect(form).not.toContainText('Draft saved for this exact version and anchor');
    expect(await retained(page, key)).toEqual({ body: '', versionId, filePath: 'motion.md', line: 1 });
    expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
    await page.evaluate(() => (window as unknown as { releaseCommentWriter: () => void }).releaseCommentWriter());
    await expect.poll(() => retained(page, key)).toEqual({ body: 'Still waiting for the retained writer.', versionId, filePath: 'motion.md', line: 1 });
    await expect(form).toContainText('Draft saved for this exact version and anchor');
    await page.reload(); await expect(page.getByLabel('Review comment', { exact: true })).toHaveValue('Still waiting for the retained writer.');
    await expect(page.locator('.comment-target')).toContainText('motion.md:1');
  } finally { await page.evaluate(() => (window as unknown as { releaseCommentWriter?: () => void }).releaseCommentWriter?.()); }
});

test('a committed root comment refreshes after a route remount without replacing its newer draft', async ({ page, request, baseURL }) => {
  const detail = await create(request, baseURL!), id = detail.revision.id, versionId = detail.versions[0]!.id, key = `comment-source:${id}:${versionId}`;
  const response = await request.post(new URL(`api/revisions/${id}/versions`, baseURL).href, { data: { expectedVersion: 1, files: [{ path: 'motion.md', content: 'Second immutable source.\n' }], message: 'Second version for remount.' } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto(`./#${id}`); await page.getByLabel('Version to inspect', { exact: true }).selectOption('1'); await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByRole('button', { name: 'Comment on line 1', exact: true }).click();
  await page.getByLabel('Review comment', { exact: true }).fill('This root comment is committed.');
  let release!: () => void, received!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), submitted = new Promise<void>(resolve => { received = resolve; });
  const path = `**/api/revisions/${id}/comments`;
  await page.route(path, async route => { const result = await route.fetch(); received(); await held; await route.fulfill({ response: result }); });
  try {
    await page.getByRole('button', { name: 'Add Comment', exact: true }).click(); await submitted;
    await expect(page.getByLabel('Review comment', { exact: true })).toBeDisabled();
    await page.goto('./#home'); await expect(page.locator('.comment-form')).toHaveCount(0);
    await page.goto(`./#${id}`);
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
    await expect(page.getByLabel('Comment version', { exact: true })).toHaveValue(versionId);
    await expect(page.getByLabel('Review comment', { exact: true })).toBeEnabled();
    await expect(page.getByLabel('Review comment', { exact: true })).toHaveValue('This root comment is committed.');
    await page.getByLabel('Review comment', { exact: true }).fill('A newer unsent root comment survives.');
    const refreshed = page.waitForResponse(result => result.request().method() === 'GET' && new URL(result.url()).pathname.endsWith('/api/state'));
    release(); await (await refreshed).finished(); await page.unrouteAll({ behavior: 'wait' });
    await expect(page.locator('.comment .remarkup-content').getByText('This root comment is committed.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
    await expect(page.getByLabel('Comment version', { exact: true })).toHaveValue(versionId);
    await expect(page.getByLabel('Review comment', { exact: true })).toHaveValue('A newer unsent root comment survives.');
    await expect(page.locator('.comment-target')).toContainText('motion.md:1');
    await expect.poll(() => retained(page, key)).toEqual({ body: 'A newer unsent root comment survives.', versionId, filePath: 'motion.md', line: 1 });
    await page.reload();
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
    await expect(page.getByLabel('Comment version', { exact: true })).toHaveValue(versionId);
    await expect(page.getByLabel('Review comment', { exact: true })).toHaveValue('A newer unsent root comment survives.');
    await expect(page.locator('.comment .remarkup-content').getByText('This root comment is committed.', { exact: true })).toHaveCount(1);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});
