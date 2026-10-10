import { test, expect, type APIRequestContext } from '@playwright/test';
import type { WikiDocument } from '../shared/types';

async function seedHistory(request: APIRequestContext, baseURL: string, count: number, label: string): Promise<WikiDocument> {
  const response = await request.post(new URL('api/documents', baseURL).href, {
    data: { title: label, slug: `history-${Date.now()}-${Math.random().toString(16).slice(2)}`, content: 'Original retained content', message: 'First source' },
  });
  expect(response.ok()).toBe(true);
  let document = await response.json() as WikiDocument;
  for (let number = 2; number <= count; number++) {
    const update = await request.put(new URL(`api/documents/${document.id}`, baseURL).href, {
      data: { title: label, slug: document.slug, content: `Retained source for version ${number}`, expectedVersion: document.version, message: `Edit ${number}` },
    });
    expect(update.ok()).toBe(true);
    document = await update.json() as WikiDocument;
  }
  return document;
}

test('wiki edits compare and restore without rewriting history', async ({ page, request, baseURL }, info) => {
  const title = `Document history ${info.project.name} ${Date.now()}`;
  await page.goto('./#wiki');
  await page.getByRole('button', { name: 'Create Document', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await dialog.getByLabel('Document slug', { exact: true }).fill(`wiki-${info.project.name}-${Date.now()}`);
  await dialog.getByRole('textbox', { name: /^Content/ }).fill('The manuscript needs a short introduction.');
  await dialog.getByRole('textbox', { name: /^Edit summary/ }).fill('Initial argument');
  await dialog.getByRole('button', { name: 'Create Document', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
  const id = new URL(page.url()).hash.slice(1);
  expect(id).toMatch(/^W\d+$/);
  await page.getByRole('button', { name: 'Edit Document', exact: true }).click();
  await dialog.getByRole('textbox', { name: /^Content/ }).fill('The manuscript needs a precise introduction.');
  await dialog.getByRole('textbox', { name: /^Edit summary/ }).fill('Make the requirement precise');
  await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
  await page.getByRole('tab', { name: 'Compare', exact: true }).click();
  await page.getByLabel('Compare with version', { exact: true }).fill('1');
  await expect(page.locator('.wiki-diff ins')).toContainText('precise');
  await expect(page.locator('.wiki-diff del')).toContainText('short');
  await page.screenshot({ path: `.data/${info.project.name}-wiki.png`, fullPage: true });
  await page.getByRole('tab', { name: 'Document', exact: true }).click();
  await page.getByLabel('Version to inspect', { exact: true }).fill('1');
  await expect(page.locator('.wiki-content')).toHaveText('The manuscript needs a short introduction.');
  page.once('dialog', confirmation => void confirmation.accept());
  await page.getByRole('button', { name: 'Restore as new version', exact: true }).click();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('3');
  await page.reload();
  await expect(page.locator('.wiki-content')).toHaveText('The manuscript needs a short introduction.');
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(page.locator('.wiki-history-entry')).toHaveCount(3);
  await expect(page.locator('.wiki-history')).toContainText('Make the requirement precise');
  const second = await request.get(new URL(`api/documents/${id}/versions/2`, baseURL!).href);
  expect((await second.json()).content).toBe('The manuscript needs a precise introduction.');
  await page.goto('./#home');
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  await page.getByRole('textbox', { name: 'Workspace command', exact: true }).fill(`open ${id}`);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('wiki offline history distinguishes cached and unopened versions', async ({ page, context, request, baseURL }) => {
  const document = await seedHistory(request, baseURL!, 3, 'Offline wiki history');
  await page.goto(`./#${document.id}`);
  await expect(page.locator('.wiki-content')).toHaveText('Retained source for version 3');
  await page.getByLabel('Version to inspect', { exact: true }).fill('1');
  await expect(page.locator('.wiki-content')).toHaveText('Original retained content');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await page.reload();
  await page.getByLabel('Version to inspect', { exact: true }).fill('1');
  await expect(page.locator('.wiki-content')).toHaveText('Original retained content');
  await expect(page.getByRole('button', { name: 'Restore as new version', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Edit Document', exact: true })).toBeDisabled();
  await page.getByLabel('Version to inspect', { exact: true }).fill('2');
  await expect(page.getByText('Version 2 has not been saved on this device. Reconnect to read it.', { exact: true })).toBeVisible();
  await context.setOffline(false);
  await expect(page.locator('.wiki-content')).toHaveText('Retained source for version 2');
});

test('late workspace discovery and newer edits preserve an explicitly selected historical wiki version', async ({ page, request, baseURL }) => {
  const document = await seedHistory(request, baseURL!, 3, 'Stable historical wiki selection');
  const stateURL = new URL('api/state', baseURL!).href;
  let release!: () => void; let captured!: () => void; let held = true;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { captured = resolve; });
  await page.route(stateURL, async route => {
    if (!held) { await route.continue(); return; }
    const response = await route.fetch(); captured(); await hold; await route.fulfill({ response });
  });
  try {
    await page.goto(`./#${document.id}`); await ready;
    await expect(page.locator('.wiki-content')).toHaveText('Retained source for version 3');
    const selection = page.getByLabel('Version to inspect', { exact: true });
    await selection.fill('1');
    await expect(page.locator('.wiki-content')).toHaveText('Original retained content');
    const stateResponse = page.waitForResponse(response => response.url() === stateURL);
    held = false; release(); await (await stateResponse).finished();
    await expect.poll(() => page.evaluate(id => Object.keys(localStorage).filter(key => key.endsWith(':state')).some(key => JSON.parse(localStorage.getItem(key)!).documents?.some((entry: { id: string; version: number }) => entry.id === id && entry.version === 3)), document.id)).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(selection).toHaveValue('1'); await expect(page.locator('.wiki-content')).toHaveText('Original retained content');
    const update = await request.put(new URL(`api/documents/${document.id}`, baseURL!).href, { data: { title: document.title, slug: document.slug, content: 'A new current head', expectedVersion: 3 } });
    expect(update.ok()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByText(`${document.slug} · Current version 4`, { exact: true })).toBeVisible();
    await expect(selection).toHaveValue('1'); await expect(page.locator('.wiki-content')).toHaveText('Original retained content');
    await page.getByRole('button', { name: 'Current version', exact: true }).click();
    await expect(selection).toHaveValue('4'); await expect(page.locator('.wiki-content')).toHaveText('A new current head');
  } finally { held = false; release(); }
});

test('wiki history pages reach old content without duplicating versions', async ({ page, request, baseURL }) => {
  const document = await seedHistory(request, baseURL!, 23, 'Paginated wiki history');
  await page.goto(`./#${document.id}`);
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(page.locator('.wiki-history-entry')).toHaveCount(20);
  await page.getByRole('button', { name: 'Load older history', exact: true }).click();
  await expect(page.locator('.wiki-history-entry')).toHaveCount(23);
  await expect(page.getByRole('button', { name: 'Load older history', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Version 1 ·/ }).click();
  await expect(page.locator('.wiki-content')).toHaveText('Original retained content');
});

for (const navigateAway of [false, true]) test(`a late document refresh cannot replace a newer version${navigateAway ? ' after navigating away and back' : ''}`, async ({ page, request, baseURL }) => {
  const document = await seedHistory(request, baseURL!, 1, 'Concurrent wiki refresh');
  const endpoint = new URL(`api/documents/${document.id}`, baseURL!).href;
  let release!: () => void;
  let captured!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { captured = resolve; });
  let first = true;
  await page.route(endpoint, async route => {
    if (!first) { await route.continue(); return; }
    first = false;
    const response = await route.fetch();
    expect((await response.json()).document.version).toBe(1);
    captured();
    await hold;
    await route.fulfill({ response });
  });
  try {
    // Hold an actual initial response; synthetic offline events may be batched
    // with a successful workspace refresh and never trigger another wiki load.
    await page.goto(`./#${document.id}`);
    await ready;
    if (navigateAway) {
      await page.evaluate(() => { location.hash = 'home'; });
      await expect(page.locator('.wiki-content')).toHaveCount(0);
    }
    const updated = await request.put(endpoint, { data: { title: document.title, slug: document.slug, content: 'Newer content must remain visible', expectedVersion: 1 } });
    expect(updated.ok()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    if (navigateAway) await page.evaluate(id => { location.hash = id; }, document.id);
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
    await expect(page.locator('.wiki-content')).toHaveText('Newer content must remain visible');
    const late = page.waitForResponse(response => response.url() === endpoint);
    release();
    await (await late).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
    await expect(page.locator('.wiki-content')).toHaveText('Newer content must remain visible');
    const stored = await page.evaluate(() => Object.keys(localStorage).filter(key => key.endsWith(`wiki:${location.hash.slice(1)}`)).map(key => JSON.parse(localStorage.getItem(key)!)));
    expect(stored[0].document.version).toBe(2);
  } finally { release(); }
});
