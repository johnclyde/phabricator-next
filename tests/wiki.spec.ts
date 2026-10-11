import { test, expect, type APIRequestContext, type Request } from '@playwright/test';
import type { AppState, WikiDocument } from '../shared/types';

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
  await dialog.getByLabel('Document path', { exact: true }).fill(`wiki-${info.project.name}-${Date.now()}`);
  await dialog.getByRole('textbox', { name: /^Content/ }).fill('The manuscript needs a short introduction.');
  await dialog.getByRole('textbox', { name: /^Edit summary/ }).fill('Initial argument');
  await dialog.getByRole('button', { name: 'Check Document Path', exact: true }).click();
  await expect(dialog.getByText('This document can be created here.', { exact: true })).toBeVisible();
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

test('late workspace discovery keeps history pages already opened by the reader', async ({ page, request, baseURL }) => {
  const document = await seedHistory(request, baseURL!, 23, 'Expanded history survives discovery');
  const stateURL = new URL('api/state', baseURL!).href;
  const detailURL = new URL(`api/documents/${document.id}`, baseURL!).href;
  let release!: () => void; let captured!: () => void; let holding = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { captured = resolve; });
  await page.route(stateURL, async route => {
    if (!holding) { await route.continue(); return; }
    const response = await route.fetch(); captured(); await gate; await route.fulfill({ response });
  });
  try {
    await page.goto(`./#${document.id}`); await ready;
    await page.getByRole('tab', { name: 'History', exact: true }).click();
    await expect(page.locator('.wiki-history-entry')).toHaveCount(20);
    await page.getByRole('button', { name: 'Load older history', exact: true }).click();
    await expect(page.locator('.wiki-history-entry')).toHaveCount(23);
    const refreshed = page.waitForResponse(response => response.url() === detailURL);
    holding = false; release(); await (await refreshed).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('.wiki-history-entry')).toHaveCount(23);
    await expect(page.getByRole('button', { name: 'Load older history', exact: true })).toHaveCount(0);
    expect(await page.evaluate(id => Object.keys(localStorage).filter(key => key.endsWith(`:wiki:${id}`)).map(key => JSON.parse(localStorage.getItem(key)!).history.versions.length), document.id)).toEqual([23]);
  } finally { holding = false; release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('a pending wiki history page survives a newer head and leaves a large intervening gap pageable', async ({ page, request, baseURL }) => {
  let document = await seedHistory(request, baseURL!, 23, 'History gap after a new head');
  const detailURL = new URL(`api/documents/${document.id}`, baseURL!).href;
  const initialDetail = await request.get(detailURL);
  expect(initialDetail.ok()).toBe(true);
  let holdInitialHead = true;
  // The race under test has two observed heads: 23 and 48. Initial workspace
  // discovery can otherwise request an intermediate head while the fixture
  // creates versions, legitimately retaining more rows than this scenario.
  await page.route(detailURL, async route => {
    if (holdInitialHead && route.request().method() === 'GET') { await route.fulfill({ response: initialDetail }); return; }
    await route.continue();
  });
  await page.goto(`./#${document.id}`);
  await expect(page.getByRole('button', { name: 'Edit Document', exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(page.locator('.wiki-history-entry')).toHaveCount(20);
  let release!: () => void; let captured!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { captured = resolve; });
  const olderURL = new URL(`api/documents/${document.id}/history?before=4&limit=20`, baseURL!).href;
  await page.route(olderURL, async route => { const response = await route.fetch(); captured(); await gate; await route.fulfill({ response }); });
  try {
    await page.getByRole('button', { name: 'Load older history', exact: true }).click(); await ready;
    for (let number = 24; number <= 48; number++) {
      const response = await request.put(new URL(`api/documents/${document.id}`, baseURL!).href, { data: { title: document.title, slug: document.slug, content: `Retained source for version ${number}`, expectedVersion: document.version } });
      expect(response.ok()).toBe(true); document = await response.json() as WikiDocument;
    }
    holdInitialHead = false;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByText(`${document.slug} · Current version 48`, { exact: true })).toBeVisible();
    release();
    await expect(page.locator('.wiki-history-entry')).toHaveCount(43);
    const fillGap = page.waitForResponse(response => response.url().endsWith(`/api/documents/${document.id}/history?before=29&limit=20`));
    await page.getByRole('button', { name: 'Load older history', exact: true }).click(); expect((await fillGap).ok()).toBe(true);
    await expect(page.locator('.wiki-history-entry')).toHaveCount(48);
    await expect(page.getByRole('button', { name: 'Load older history', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /^Version 1 ·/ }).click();
    await expect(page.locator('.wiki-content')).toHaveText('Original retained content');
    await expect(page.getByText(`${document.slug} · Current version 48`, { exact: true })).toBeVisible();
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('a late wiki history page cannot restore rendered or cached content after view access is revoked', async ({ page, request, baseURL }) => {
  const document = await seedHistory(request, baseURL!, 23, 'Revoked paginated history');
  // Hold JSON delivery after the real response body is read, so the test covers
  // the stale-response guard even when aborting fetch can no longer help.
  await page.addInitScript(() => {
    const state = { ready: false, released: false, release: () => {} };
    const gate = new Promise<void>(resolve => { state.release = resolve; });
    (window as unknown as { heldWikiHistory: typeof state }).heldWikiHistory = state;
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const input = args[0]; const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (/\/api\/documents\/W\d+\/history$/.test(url.pathname)) {
        const json = response.json.bind(response);
        response.json = async () => { const data: unknown = await json(); state.ready = true; await gate; state.released = true; return data; };
      }
      return response;
    };
  });
  await page.goto(`./#${document.id}`);
  await expect(page.getByRole('button', { name: 'Edit Document', exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: 'Load older history', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { heldWikiHistory: { ready: boolean } }).heldWikiHistory.ready)).toBe(true);
  // Supply the authoritative shape of a revoked-view refresh. Policy API tests
  // separately cover who may revoke access; this test isolates late JSON and
  // durable-cache handling without bypassing local policy self-lockout rules.
  await page.route(new URL('api/state', baseURL!).href, async route => {
    const response = await route.fetch(); const state = await response.json() as AppState;
    state.documents = state.documents.filter(item => item.id !== document.id);
    state.activity = state.activity.filter(item => item.objectId !== document.id);
    delete state.access[document.id]; state.accessEpoch++;
    await route.fulfill({ response, json: state });
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', { name: 'Object unavailable', exact: true })).toBeVisible();
    await page.evaluate(() => (window as unknown as { heldWikiHistory: { release: () => void } }).heldWikiHistory.release());
    await expect.poll(() => page.evaluate(() => (window as unknown as { heldWikiHistory: { released: boolean } }).heldWikiHistory.released)).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('.wiki-history-entry')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(document.title);
    expect(await page.evaluate(id => Object.keys(localStorage).filter(key => key.includes(`:wiki:${id}`)), document.id)).toEqual([]);
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

for (const navigateAway of [false, true]) test(`a late document refresh cannot replace a newer version${navigateAway ? ' after navigating away and back' : ''}`, async ({ page, request, baseURL }) => {
  const document = await seedHistory(request, baseURL!, 1, 'Concurrent wiki refresh');
  const endpoint = new URL(`api/documents/${document.id}`, baseURL!).href;
  let release!: () => void;
  let captured!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { captured = resolve; });
  let first = true;
  let heldRequest!: Request;
  await page.route(endpoint, async route => {
    if (!first) { await route.continue(); return; }
    first = false; heldRequest = route.request();
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
    release();
    // Access-epoch retirement may abort the old read before it is released.
    // Await that specific request rather than an unrelated subsequent read.
    const late = await heldRequest.response();
    if (late) await late.finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
    await expect(page.locator('.wiki-content')).toHaveText('Newer content must remain visible');
    const stored = await page.evaluate(() => Object.keys(localStorage).filter(key => key.endsWith(`wiki:${location.hash.slice(1)}`)).map(key => JSON.parse(localStorage.getItem(key)!)));
    expect(stored[0].document.version).toBe(2);
  } finally { release(); }
});
