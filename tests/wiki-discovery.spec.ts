import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { AppState, WikiDetail, WikiDocument } from '../shared/types';
import type { WikiDocumentSearchPage } from '../shared/wiki-search';

const token = () => `discover-${randomUUID().slice(0, 8)}`;
async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> {
  const url = new URL(`api${path}`, baseURL).href, response = body === undefined ? await request.get(url) : await request.post(url, { data: body, headers: { 'Idempotency-Key': randomUUID() } });
  expect(response.ok(), await response.text()).toBe(true); return response.json();
}
async function create(request: APIRequestContext, baseURL: string, title: string, path = token(), content = `Published source for ${title}`): Promise<WikiDocument> { return api(request, baseURL, '/documents', { title, slug: path, content }); }
function pins(detail: WikiDetail) { const value = detail.document.publication!; return { expectedVersion: value.headVersion, expectedHeadVersionId: value.headVersionId, expectedPublishedVersionId: value.publishedVersionId, expectedPublicationRevision: value.revision, expectedAccessEpoch: detail.accessEpoch }; }
async function search(page: Page, value: string) { await page.getByLabel('Search published documents', { exact: true }).fill(value); }
async function refine(page: Page) { await page.getByText('Refine Search', { exact: true }).click(); }

test('wiki discovery defaults to active published content and exposes inactive documents explicitly', async ({ page, request, baseURL }, info) => {
  const label = token(), active = await create(request, baseURL!, `${label} Active`), deleted = await create(request, baseURL!, `${label} Deleted`), detail = await api<WikiDetail>(request, baseURL!, `/documents/${deleted.id}`);
  await api(request, baseURL!, `/documents/${deleted.id}/delete`, pins(detail));
  const beforeDraft = await api<WikiDetail>(request, baseURL!, `/documents/${active.id}`), draftSecret = `UNPUBLISHED-${token()}`;
  await api(request, baseURL!, `/documents/${active.id}/drafts`, { ...pins(beforeDraft), title: 'Unpublished draft title', content: draftSecret });
  await page.goto('./#wiki'); await search(page, label); await expect(page.locator('.wiki-search-row')).toHaveCount(1); await expect(page.locator('.wiki-search-row')).toContainText(`${label} Active`); await expect(page.locator('.wiki-search-row')).toContainText('Published version 1 · Latest content 2');
  await page.getByRole('button', { name: 'All', exact: true }).click(); await expect(page.locator('.wiki-search-row')).toHaveCount(2);
  await refine(page); await page.getByLabel('Deleted', { exact: true }).check(); await page.getByRole('button', { name: 'Apply Filters', exact: true }).click(); await expect(page.locator('.wiki-search-row')).toHaveCount(1); await expect(page.locator('.wiki-search-row')).toContainText(`${label} Deleted`);
  await page.getByRole('button', { name: 'Reset Search', exact: true }).click(); await search(page, draftSecret); await expect(page.getByText('No documents match this search.', { exact: true })).toBeVisible(); await expect(page.locator('.wiki-search-row')).toHaveCount(0);
  await search(page, label); await expect(page.locator('.wiki-search-row')).toHaveCount(1); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `.data/wiki-discovery-visual/${process.env.APP_BASE_PATH ? 'mounted' : 'root'}/${info.project.name}.png`, fullPage: true }); await refine(page); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `.data/wiki-discovery-visual/${process.env.APP_BASE_PATH ? 'mounted' : 'root'}/${info.project.name}-viewport.png` });
  await page.locator('.wiki-search-row h3 a').click(); await expect(page.locator('.wiki-content')).toHaveText(`Published source for ${label} Active`);
});

test('wiki discovery canonicalizes exact, parent and ancestor path lists with their declared combination rules', async ({ page, request, baseURL }) => {
  const path = token(), parent = await create(request, baseURL!, 'Discovery parent', path), child = await create(request, baseURL!, 'Discovery child', `${path}/child`), grandchild = await create(request, baseURL!, 'Discovery grandchild', `${path}/child/nested`);
  await page.goto('./#wiki'); await refine(page); await page.getByLabel('Exact paths', { exact: true }).fill(` /${path.toUpperCase()}/CHILD/\n${child.slug}`); await page.getByRole('button', { name: 'Apply Filters', exact: true }).click(); await expect(page.locator('.wiki-search-row')).toHaveCount(1); await expect(page.locator('.wiki-search-row')).toContainText(child.id);
  await page.getByLabel('Exact paths', { exact: true }).fill(''); await page.getByLabel('Direct children of paths', { exact: true }).fill(parent.slug); await page.getByRole('button', { name: 'Apply Filters', exact: true }).click(); await expect(page.locator('.wiki-search-row')).toHaveCount(1); await expect(page.locator('.wiki-search-row')).toContainText(child.id);
  await page.getByLabel('Descendants of paths', { exact: true }).fill(child.slug); await page.getByRole('button', { name: 'Apply Filters', exact: true }).click(); await expect(page.locator('.wiki-search-row')).toHaveCount(2); await expect(page.locator('.wiki-search-results')).toContainText(grandchild.id);
  await page.getByLabel('Exact paths', { exact: true }).fill(grandchild.slug); await page.getByRole('button', { name: 'Apply Filters', exact: true }).click(); await expect(page.locator('.wiki-search-row')).toHaveCount(1); await expect(page.locator('.wiki-search-row')).toContainText(grandchild.id);
});

test('wiki discovery pages and saved searches remain usable offline without searching unsaved content', async ({ page, request, baseURL, context }) => {
  const label = token(); for (let index = 0; index < 28; index++) await create(request, baseURL!, `${label} ${index}`);
  await page.goto('./#wiki'); await search(page, label); await expect(page.locator('.wiki-search-row')).toHaveCount(25); await page.getByRole('button', { name: 'Load More Documents', exact: true }).click(); await expect(page.locator('.wiki-search-row')).toHaveCount(28); await expect(page.getByRole('button', { name: 'Load More Documents', exact: true })).not.toBeVisible();
  const links = await page.locator('.wiki-search-meta a').evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).hash)); expect(new Set(links).size).toBe(28);
  await context.setOffline(true); await expect(page.getByText('Saved search snapshot. Reconnect to refresh results or search content that has not been saved.', { exact: true })).toBeVisible(); await expect(page.locator('.wiki-search-row')).toHaveCount(28);
  await search(page, `${label}-not-cached`); await expect(page.getByText('This search has not been saved on this device.', { exact: true })).toBeVisible(); await expect(page.locator('.wiki-search-row')).toHaveCount(0);
  await search(page, label); await expect(page.locator('.wiki-search-row')).toHaveCount(28); await context.setOffline(false); await expect(page.getByRole('button', { name: 'Refresh Documents', exact: true })).toBeEnabled();
});

test.describe('wiki discovery network races', () => {
  // Request interception must not race service-worker control. The offline
  // snapshot case above keeps the application's normal service worker enabled.
  test.use({ serviceWorkers: 'block' });

test('late wiki searches cannot replace newer filters, and empty scanned pages can continue', async ({ page, request, baseURL }) => {
  const old = token(), next = token(); await create(request, baseURL!, old); await create(request, baseURL!, next);
  await page.goto('./#wiki'); let release!: () => void, ready!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), received = new Promise<void>(resolve => { ready = resolve; }); let once = true;
  await page.route('**/api/documents?**', async route => { if (!once || new URL(route.request().url()).searchParams.get('query') !== old) return route.continue(); once = false; const response = await route.fetch(); ready(); await held; await route.fulfill({ response }); });
  await search(page, old); await received; await search(page, next); await expect(page.locator('.wiki-search-row')).toHaveCount(1); await expect(page.locator('.wiki-search-row')).toContainText(next); release(); await page.unrouteAll({ behavior: 'wait' }); await expect(page.locator('.wiki-search-row')).not.toContainText(old);
  const original = await api<WikiDocumentSearchPage>(request, baseURL!, `/documents?query=${next}&queryKey=active`), cursor = 'opaque scan + / cursor';
  await page.route('**/api/documents?**', route => { const params = new URL(route.request().url()).searchParams; return route.fulfill({ json: params.has('after') ? original : { documents: [], nextAfter: cursor, nextBefore: null, accessEpoch: original.accessEpoch } }); });
  await page.getByRole('button', { name: 'Refresh Documents', exact: true }).click(); await expect(page.getByRole('button', { name: 'Continue Search', exact: true })).toBeVisible(); const continuation = page.waitForRequest(request => new URL(request.url()).searchParams.get('after') === cursor); await page.getByRole('button', { name: 'Continue Search', exact: true }).click(); await continuation; await expect(page.locator('.wiki-search-row')).toHaveCount(1);
});

test('access retirement removes cached discovery text and rejects a late decoded response', async ({ page, request, baseURL }) => {
  const label = token(), document = await create(request, baseURL!, label);
  await page.addInitScript(() => { const state = { hold: false, ready: false, released: false, release: () => {} }; const gate = new Promise<void>(resolve => { state.release = resolve; }); (window as unknown as { heldWikiSearch: typeof state }).heldWikiSearch = state; const original = window.fetch; window.fetch = async (...args) => { const response = await original(...args), input = args[0], url = new URL(input instanceof Request ? input.url : String(input), location.href); if (state.hold && /\/api\/documents$/.test(url.pathname)) { state.hold = false; const json = response.json.bind(response); response.json = async () => { const data: unknown = await json(); state.ready = true; await gate; state.released = true; return data; }; } return response; }; });
  await page.goto('./#wiki'); await search(page, label); await expect(page.locator('.wiki-search-row')).toHaveCount(1); await page.evaluate(() => { (window as unknown as { heldWikiSearch: { hold: boolean } }).heldWikiSearch.hold = true; }); await page.getByRole('button', { name: 'Refresh Documents', exact: true }).click(); await expect.poll(() => page.evaluate(() => (window as unknown as { heldWikiSearch: { ready: boolean } }).heldWikiSearch.ready)).toBe(true);
  const state = await api<AppState>(request, baseURL!, '/state'); state.documents = state.documents.filter(item => item.id !== document.id); delete state.access[document.id]; state.activity = state.activity.filter(item => item.objectId !== document.id); state.accessEpoch++;
  await page.route(new URL('api/state', baseURL!).href, route => route.fulfill({ json: state })); await page.route('**/api/documents?**', route => route.fulfill({ json: { documents: [], nextAfter: null, nextBefore: null, accessEpoch: state.accessEpoch } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.locator('.wiki-search-row')).toHaveCount(0); await page.evaluate(() => (window as unknown as { heldWikiSearch: { release: () => void } }).heldWikiSearch.release()); await expect.poll(() => page.evaluate(() => (window as unknown as { heldWikiSearch: { released: boolean } }).heldWikiSearch.released)).toBe(true);
  await expect(page.locator('.wiki-search-results')).not.toContainText(label); expect(await page.evaluate(text => Object.keys(localStorage).filter(key => key.includes('wiki-search:')).some(key => localStorage.getItem(key)?.includes(text)), label)).toBe(false);
});

});
