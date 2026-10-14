import { test, expect, type Page } from '@playwright/test';
import { reviewerApi as api, reviewerSignIn as signIn } from './revision-reviewers-browser';
import { emptySearchQuery, searchParameters, type SavedSearchList, type SavedSearchReceipt } from '../shared/search';
import type { Task } from '../shared/types';

const nonce = (prefix: string) => `${prefix} ${crypto.randomUUID().slice(0, 8)}`;
const results = (page: Page) => page.locator('.workspace-search-results');
async function search(page: Page, text: string) {
  await page.getByLabel('Full-text query', { exact: true }).fill(text);
  await page.locator('.workspace-search').getByRole('button', { name: 'Search', exact: true }).click();
}
async function manage(page: Page) {
  const details = page.locator('.search-save');
  if (!await details.evaluate(node => (node as HTMLDetailsElement).open)) await details.locator('summary').click();
}
async function command(page: Page, text: string) {
  if (!await page.getByLabel('Workspace command', { exact: true }).isVisible()) await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  await page.getByLabel('Workspace command', { exact: true }).fill(text); await page.getByLabel('Workspace command', { exact: true }).press('Enter');
}

test('full-text search finds body phrases, retires edited body text, and global keyboard and voice search open the shared engine', async ({ page }, info) => {
  await page.goto('./#home'); const phrase = nonce('precise archival passage'), updated = nonce('replacement archival passage');
  const task = await api<Task>(page, '/tasks', { title: nonce('Plain title'), description: `The document contains ${phrase} in its body.` });
  await page.getByLabel('Search workspace', { exact: true }).fill(`"${phrase}"`); await page.getByLabel('Search workspace', { exact: true }).press('Enter');
  await expect(results(page).getByRole('link', { name: new RegExp(task.id) })).toBeVisible();
  await expect(results(page)).toContainText(phrase);
  await api(page, `/tasks/${task.id}`, { description: `Now contains ${updated}.`, expectedVersion: task.version }, 'PATCH');
  await page.getByRole('button', { name: 'Refresh results', exact: true }).click();
  await expect(results(page)).toContainText('No results match this query.');
  await command(page, `search ${updated}`);
  await expect(page.getByLabel('Full-text query', { exact: true })).toHaveValue(updated);
  await expect(results(page).getByRole('link', { name: new RegExp(task.id) })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.locator('.workspace-search').screenshot({ path: info.outputPath('workspace-search.png') });
});

test('saved queries create, edit, reload, share explicitly, and delete with exact filters', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    const title = nonce('Named research query'), renamed = nonce('Shared research query'), body = nonce('shared query evidence');
    await api(alice.page, '/tasks', { title: nonce('Saved query task'), description: body });
    await alice.page.goto('./#search'); await search(alice.page, `"${body}"`); await manage(alice.page);
    await alice.page.getByLabel('Query name', { exact: true }).fill(title); await alice.page.getByRole('button', { name: 'Save as new query', exact: true }).click();
    await expect(alice.page.locator('.search-saved-list')).toContainText(title);
    const created = (await api<SavedSearchList>(alice.page, '/search/queries')).queries.find(item => item.name === title)!;
    expect(created.visibility).toBe('private'); expect((await api<SavedSearchList>(bob.page, '/search/queries')).queries.some(item => item.id === created.id)).toBe(false);
    await alice.page.reload(); await expect(alice.page.getByLabel('Full-text query', { exact: true })).toHaveValue(`"${body}"`); await manage(alice.page);
    await alice.page.getByLabel('Query name', { exact: true }).fill(renamed); await alice.page.getByRole('combobox', { name: /^Query visibility/ }).selectOption('workspace');
    await alice.page.getByRole('button', { name: 'Update saved query', exact: true }).click();
    await expect(alice.page.locator('.search-saved-list')).toContainText(renamed); await expect(alice.page.getByRole('button', { name: 'Retry saved query request', exact: true })).toHaveCount(0);
    await bob.page.goto(`./#search/${created.id}`); await expect(bob.page.getByLabel('Full-text query', { exact: true })).toHaveValue(`"${body}"`);
    await expect(results(bob.page)).toContainText(body); await manage(bob.page); await expect(bob.page.getByRole('button', { name: 'Update saved query', exact: true })).toHaveCount(0);
    alice.page.once('dialog', dialog => void dialog.accept()); await alice.page.getByRole('button', { name: 'Delete saved query', exact: true }).click();
    await expect(alice.page.locator('.search-saved-list')).not.toContainText(renamed);
    expect((await api<SavedSearchList>(bob.page, '/search/queries')).queries.some(item => item.id === created.id)).toBe(false);
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('lost saved-query responses retry the immutable request while newer form edits survive', async ({ page }) => {
  await page.goto('./#search'); const name = nonce('Lost query'), newer = nonce('Newer unsent query'), source = nonce('exact filter');
  await search(page, source); await manage(page); await page.getByLabel('Query name', { exact: true }).fill(name);
  let first = true; const payloads: unknown[] = [], keys: string[] = [];
  await page.route('**/api/search/queries', async intercepted => {
    if (intercepted.request().method() !== 'POST') return intercepted.continue();
    payloads.push(intercepted.request().postDataJSON()); keys.push(intercepted.request().headers()['idempotency-key']!);
    if (first) { first = false; const response = await intercepted.fetch(); expect(response.ok()).toBe(true); return intercepted.abort('failed'); }
    return intercepted.continue();
  });
  await page.getByRole('button', { name: 'Save as new query', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry saved query request', exact: true })).toBeVisible();
  await page.getByLabel('Query name', { exact: true }).fill(newer); await page.getByLabel('Full-text query', { exact: true }).fill('newer unsent filter');
  await page.getByRole('button', { name: 'Retry saved query request', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry saved query request', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Query name', { exact: true })).toHaveValue(newer); await expect(page.getByLabel('Full-text query', { exact: true })).toHaveValue('newer unsent filter');
  expect(payloads).toHaveLength(2); expect(payloads[1]).toEqual(payloads[0]); expect(keys[1]).toEqual(keys[0]);
  const saved = await api<SavedSearchList>(page, '/search/queries'); expect(saved.queries.filter(item => item.name === name)).toHaveLength(1); expect(saved.queries.some(item => item.name === newer)).toBe(false);
});

test('invalid search links fail closed and cannot display a delayed earlier result', async ({ page }) => {
  await page.goto('./#home'); const phrase = nonce('must not display after malformed query');
  await api(page, '/tasks', { title: phrase });
  const requests: string[] = []; page.on('request', request => { if (/\/api\/search\?/.test(request.url())) requests.push(request.url()); });
  await page.goto('./#search?kinds=malformed-json');
  await expect(page.locator('.workspace-search [role="alert"]')).toBeVisible();
  await expect(results(page)).toHaveCount(0); expect(requests).toHaveLength(0);
  let release!: () => void, entered = false; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/search?**', async intercepted => { const response = await intercepted.fetch(); entered = true; await held; await intercepted.fulfill({ response }); });
  await page.goto(`./#search?${searchParameters({ ...emptySearchQuery(), text: phrase })}`);
  await expect.poll(() => entered).toBe(true);
  await page.evaluate(() => { location.hash = 'search?kinds=malformed-json'; });
  await expect(page.locator('.workspace-search [role="alert"]')).toBeVisible(); release();
  await expect(results(page)).toHaveCount(0); await expect(page.locator('.workspace-search')).not.toContainText(phrase);
  await page.unrouteAll({ behavior: 'wait' });
});

test('withdrawing a shared saved query retires its filters and results in an already open viewer', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    const text = nonce('previously shared query terms'); await api(alice.page, '/tasks', { title: text });
    const created = await api<SavedSearchReceipt>(alice.page, '/search/queries', { name: nonce('Withdrawable query'), visibility: 'workspace', query: { ...emptySearchQuery(), text } });
    await bob.page.goto(`./#search/${created.query!.id}`); await expect(results(bob.page)).toContainText(text);
    await api(alice.page, `/search/queries/${created.query!.id}`, { name: created.query!.name, visibility: 'private', query: created.query!.query, expectedVersion: created.query!.version });
    await bob.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(bob.page.getByLabel('Full-text query', { exact: true })).toHaveValue('');
    await expect(results(bob.page)).toHaveCount(0); await expect(bob.page.locator('.workspace-search')).not.toContainText(text);
  } finally { await alice.context.close(); await bob.context.close(); }
});
