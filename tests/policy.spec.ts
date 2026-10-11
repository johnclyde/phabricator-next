import { test, expect, type Browser, type Download, type Page, type TestInfo } from '@playwright/test';
import { normalizeBasePath } from '../shared/mount';
import { authAccounts } from './auth-fixture';

const base = normalizeBasePath(process.env.APP_BASE_PATH);
const authenticatedBase = `http://127.0.0.1:4312${base}`;
test.use({ baseURL: authenticatedBase });

async function signIn(page: Page, index: number) {
  await page.goto(`${authenticatedBase}#home`);
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  const account = authAccounts[index]!;
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.locator('.signed-in-user')).toHaveText(account.displayName);
  await expect(page.getByRole('button', { name: 'Create Task', exact: true })).toBeEnabled();
}

async function secondActor(browser: Browser, first: Page, info: TestInfo) {
  const context = await browser.newContext({
    baseURL: authenticatedBase, viewport: first.viewportSize(),
    isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch,
    deviceScaleFactor: info.project.use.deviceScaleFactor,
  });
  return { context, page: await context.newPage() };
}

async function navigate(page: Page, label: string) {
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('navigation', { name: 'Applications', exact: true }).getByRole('link', { name: new RegExp(`^${label}`) }).click();
}

async function command(page: Page, value: string) {
  const input = page.getByRole('textbox', { name: 'Workspace command', exact: true });
  if (!await input.isVisible()) await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  await input.fill(value);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
}

async function search(page: Page, value: string) {
  const input = page.getByRole('textbox', { name: 'Search workspace', exact: true });
  if (await input.isVisible()) await input.fill(value);
  else {
    await command(page, `search for ${value}`);
    await page.getByRole('button', { name: 'Close voice panel', exact: true }).click();
  }
}

async function createWiki(page: Page, title: string, content: string, spaceId = 'S1') {
  // Password workspaces begin empty. Child creation needs a readable, editable root.
  await page.evaluate(async ({ base }) => {
    const session = await (await fetch(`${base}api/session`)).json();
    const response = await fetch(`${base}api/wiki?path=%2F`, { headers: { 'X-Session-Context': session.sessionContext } }), root = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(root));
    if (!root.document) {
      const created = await fetch(`${base}api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ title: 'Policy test wiki root', slug: '/', content: 'Shared root for policy test documents.', access: { spaceId: 'S1' }, expectedAccessEpoch: root.accessEpoch }) });
      if (!created.ok) throw new Error(await created.text());
    }
  }, { base });
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === `${base}api/state`);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await (await refreshed).finished();
  await navigate(page, 'Phriction');
  await page.getByRole('button', { name: 'Create Document', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Space', { exact: true }).selectOption(spaceId);
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await dialog.getByLabel('Document path', { exact: true }).fill(`policy-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await dialog.getByRole('textbox', { name: /^Content/ }).fill(content);
  await dialog.getByRole('button', { name: 'Check Document Path', exact: true }).click();
  await expect(dialog.getByText('This document can be created here.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Create Document', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
  await expect(page.locator('.wiki-content')).toHaveText(content);
  const id = new URL(page.url()).hash.slice(1);
  expect(id).toMatch(/^W\d+$/);
  return id;
}

async function restrictAccess(page: Page, capabilities: ('view' | 'edit' | 'interact')[]) {
  const loaded = page.waitForResponse(response => /\/api\/policies\/[A-Z0-9]+$/.test(new URL(response.url()).pathname) && response.request().method() === 'GET');
  await page.getByRole('button', { name: 'Manage access', exact: true }).click();
  await (await loaded).finished();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Save Access', exact: true })).toBeEnabled();
  for (const capability of capabilities) {
    const label = `${capability[0].toUpperCase()}${capability.slice(1)} access`;
    await dialog.getByLabel(label, { exact: true }).selectOption('principals');
    const group = dialog.getByRole('group', { name: label, exact: true });
    await expect(group.getByRole('checkbox', { name: /Alice Researcher/ })).toBeChecked();
    await expect(group.getByRole('checkbox', { name: /Bob Editor/ })).not.toBeChecked();
  }
  page.once('dialog', confirmation => void confirmation.accept());
  await dialog.getByRole('button', { name: 'Save Access', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function downloadText(download: Download) {
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

test('private Spaces keep documents and tasks out of another account’s lists, search and voice navigation', async ({ page, browser }, info) => {
  const bob = await secondActor(browser, page, info);
  try {
    await signIn(page, 0);
    const marker = `${info.project.name} ${Date.now()}`;
    const spaceName = `Private research ${marker}`;
    await navigate(page, 'Spaces');
    await page.getByRole('button', { name: 'Create Space', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Space name', { exact: true }).fill(spaceName);
    for (const name of ['View access', 'Manage Space access']) {
      await expect(dialog.getByLabel(name, { exact: true })).toHaveValue('principals');
      const group = dialog.getByRole('group', { name, exact: true });
      await expect(group.getByRole('checkbox', { name: /Alice Researcher/ })).toBeChecked();
      await expect(group.getByRole('checkbox', { name: /Bob Editor/ })).not.toBeChecked();
    }
    const created = page.waitForResponse(response => response.url().endsWith('/api/spaces') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Create Space', exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    const space = await response.json() as { id: string };
    await expect(dialog).not.toBeVisible();
    const title = `Private wiki ${marker}`;
    const source = `Confidential manuscript text ${marker}`;
    const id = await createWiki(page, title, source, space.id);
    const taskTitle = `Private task ${marker}`;
    await navigate(page, 'Maniphest');
    await page.getByRole('button', { name: 'Create Task', exact: true }).click();
    await dialog.getByLabel('Space', { exact: true }).selectOption(space.id);
    await dialog.getByLabel('Title', { exact: true }).fill(taskTitle);
    await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText(taskTitle, { exact: true })).toBeVisible();

    await signIn(bob.page, 1);
    await navigate(bob.page, 'Spaces');
    await expect(bob.page.getByRole('heading', { name: spaceName, exact: true })).toHaveCount(0);
    await navigate(bob.page, 'Phriction');
    await search(bob.page, title);
    await expect(bob.page.locator('.wiki-list .panel')).toHaveCount(0);
    await navigate(bob.page, 'Maniphest');
    await search(bob.page, taskTitle);
    await expect(bob.page.locator('.task-row')).toHaveCount(0);
    await command(bob.page, `open ${id}`);
    await expect(bob.page.getByRole('heading', { name: 'Object unavailable', exact: true })).toBeVisible();
    await expect(bob.page.locator('.wiki-content')).toHaveCount(0);
    await expect(bob.page.locator('body')).not.toContainText(source);
    expect(await bob.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await bob.page.screenshot({ path: `.data/${info.project.name}-private-space-denied.png`, fullPage: true });
  } finally { await bob.context.close(); }
});

test('access controls share readable documents while gating wiki edits, source edits and review interactions', async ({ page, browser }, info) => {
  const bob = await secondActor(browser, page, info);
  try {
    await signIn(page, 0);
    const marker = `${info.project.name} ${Date.now()}`;
    const wikiTitle = `Read-only wiki ${marker}`;
    const wikiId = await createWiki(page, wikiTitle, 'First shared version.');
    await page.getByRole('button', { name: 'Edit Document', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: /^Content/ }).fill('Second shared version.');
    await dialog.getByRole('button', { name: 'Save and Publish', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
    await restrictAccess(page, ['edit', 'interact']);

    await navigate(page, 'Drafts');
    await page.getByRole('button', { name: 'Create Draft', exact: true }).click();
    const draftTitle = `Read-only legal draft ${marker}`;
    const draftText = `A shared argument with restricted review permissions ${marker}.`;
    await dialog.getByLabel('Space', { exact: true }).selectOption('S1');
    await dialog.getByLabel('Title', { exact: true }).fill(draftTitle);
    await dialog.getByRole('textbox', { name: /^Draft text/ }).fill(draftText);
    await dialog.getByRole('button', { name: 'Create Draft', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(draftTitle);
    const draftId = new URL(page.url()).hash.slice(1);
    expect(draftId).toMatch(/^L\d+$/);
    await restrictAccess(page, ['edit', 'interact']);

    await signIn(bob.page, 1);
    await bob.page.goto(`${authenticatedBase}#${wikiId}`);
    await expect(bob.page.locator('.wiki-content')).toHaveText('Second shared version.');
    await expect(bob.page.getByRole('button', { name: 'Edit Document', exact: true })).toBeDisabled();
    await expect(bob.page.getByRole('button', { name: 'Manage access', exact: true })).toHaveCount(0);
    await bob.page.getByLabel('Version to inspect', { exact: true }).fill('1');
    await expect(bob.page.locator('.wiki-content')).toHaveText('First shared version.');
    await expect(bob.page.getByRole('button', { name: 'Restore as new version', exact: true })).toBeDisabled();
    await bob.page.goto(`${authenticatedBase}#${draftId}`);
    await expect(bob.page.getByRole('heading', { level: 1 })).toContainText(draftTitle);
    await bob.page.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(bob.page.locator('.main')).toContainText(draftText);
    await expect(bob.page.getByRole('button', { name: 'Edit & add version', exact: true })).toBeDisabled();
    await expect(bob.page.getByRole('textbox', { name: 'Review comment', exact: true })).toHaveCount(0);
    await expect(bob.page.getByRole('button', { name: 'Add Comment', exact: true })).toHaveCount(0);
    await expect(bob.page.getByText('Read-only discussion. Interact access is required to comment.', { exact: true })).toBeVisible();
    await expect(bob.page.getByRole('button', { name: 'Run Local Checks', exact: true })).toBeDisabled();
    await expect(bob.page.getByRole('region', { name: 'Revision Lifecycle', exact: true }).locator('.revision-lifecycle-actions button').first()).toBeDisabled();
    await expect(bob.page.getByRole('button', { name: 'Download source', exact: true })).toBeEnabled();
    expect(await bob.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await bob.page.screenshot({ path: `.data/${info.project.name}-policies.png`, fullPage: true });
  } finally { await bob.context.close(); }
});

test('revoked wiki access sets unsaved work aside for export and discard without submitting it', async ({ page, browser }, info) => {
  const bob = await secondActor(browser, page, info);
  try {
    await signIn(page, 0);
    const marker = `${info.project.name} ${Date.now()}`;
    const original = `The committed source stays unchanged ${marker}.`;
    const id = await createWiki(page, `Revoked wiki ${marker}`, original);
    await signIn(bob.page, 1);
    await bob.page.goto(`${authenticatedBase}#${id}`);
    await expect(bob.page.locator('.wiki-content')).toHaveText(original);
    await bob.page.getByRole('button', { name: 'Edit Document', exact: true }).click();
    const editor = bob.page.getByRole('dialog');
    const unsaved = `Bob's unsent academic argument ${marker}.`;
    await editor.getByRole('textbox', { name: /^Content/ }).fill(unsaved);
    await expect(editor).toContainText('Unsaved local changes stay on this device or in this tab.');
    const submissions: string[] = [];
    bob.page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith(`${base}api/documents/${id}`) && ['PUT', 'POST', 'PATCH'].includes(request.method())) submissions.push(request.url());
    });
    await restrictAccess(page, ['view', 'edit', 'interact']);
    const refreshed = bob.page.waitForResponse(response => response.url().endsWith('/api/state'));
    await bob.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await refreshed;
    await expect(editor).not.toBeVisible();
    await expect(bob.page.getByRole('heading', { name: 'Object unavailable', exact: true })).toBeVisible();
    await expect(bob.page.locator('.wiki-content')).toHaveCount(0);
    const quarantined = bob.page.locator('.quarantined-drafts');
    await expect(quarantined.getByRole('heading', { name: 'Drafts set aside after access changed', exact: true })).toBeVisible();
    await expect(quarantined).toContainText('They will never submit automatically.');
    const download = bob.page.waitForEvent('download');
    await quarantined.getByRole('button', { name: 'Export Draft', exact: true }).click();
    expect(JSON.parse(await downloadText(await download)).content).toBe(unsaved);
    expect(await bob.page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(unsaved);
    bob.page.once('dialog', confirmation => void confirmation.accept());
    await quarantined.getByRole('button', { name: 'Discard Draft', exact: true }).click();
    await expect(quarantined).toHaveCount(0);
    expect(submissions).toEqual([]);
    await page.reload();
    await expect(page.locator('.wiki-content')).toHaveText(original);
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
  } finally { await bob.context.close(); }
});
