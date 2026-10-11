import { test, expect, type Page, type Download } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { normalizeBasePath } from '../shared/mount';
import { gitPatchFilename } from '../shared/git-patch';
import { authAccounts } from './auth-fixture';
import type { GitPatch } from '../shared/repositories';
import type { ObjectAccess } from '../shared/policy';
import type { AppState } from '../shared/types';

type Fixture = { head: string; base: string; comparisonBase: string; comparisonTarget: string };
const fixture = async () => JSON.parse(await readFile('.data/e2e-repository-fixture.json', 'utf8')) as Fixture;
const panel = (page: Page) => page.getByLabel('Exact patch export', { exact: true });
const prepare = (page: Page) => page.getByRole('button', { name: 'Prepare Exact Patch', exact: true });
const download = (page: Page) => page.getByRole('button', { name: 'Download Exact Patch', exact: true });
async function open(page: Page) { await page.goto('./#R1'); await expect(page.locator('.repository-commit-id')).toHaveText((await fixture()).head); await page.getByRole('button', { name: 'Show Commit Changes', exact: true }).click(); await expect(panel(page)).toBeVisible(); }
async function pair(page: Page, base: string, target: string) { await page.getByLabel('Comparison base commit', { exact: true }).fill(base); await page.getByLabel('Comparison target commit', { exact: true }).fill(target); await page.getByRole('button', { name: 'Compare Exact Commits', exact: true }).click(); await expect(page.locator('.repository-comparison-pair code')).toHaveText([base === 'empty' ? 'Empty tree' : base, target]); }
async function prepared(page: Page) { await prepare(page).click(); await expect(download(page)).toBeEnabled(); }
async function bytes(value: Download): Promise<Buffer> { const path = await value.path(); expect(path).not.toBeNull(); return readFile(path!); }

test('explicit exact patch preparation downloads verified binary bytes and keeps file navigation pinned', async ({ page, request, baseURL }, info) => {
  const data = await fixture(); let requests = 0; page.on('request', value => { if (new URL(value.url()).pathname.endsWith('/compare/patch')) requests++; });
  await open(page); await expect(download(page)).toBeDisabled(); expect(requests).toBe(0);
  await prepared(page); await expect(panel(page)).toContainText('These exact trees produce an empty patch.'); const [empty] = await Promise.all([page.waitForEvent('download'), download(page).click()]); expect((await bytes(empty)).length).toBe(0); expect(requests).toBe(1);
  await pair(page, data.comparisonBase, data.comparisonTarget); await expect(download(page)).toBeDisabled(); await prepared(page);
  const result = await request.get(new URL(`api/repositories/R1/compare/patch?${new URLSearchParams({ base: data.comparisonBase, target: data.comparisonTarget })}`, baseURL!).href); expect(result.ok()).toBe(true); const patch = await result.json() as GitPatch;
  await page.locator('.repository-change-row').filter({ hasText: 'executable.sh' }).click(); await expect(download(page)).toBeEnabled();
  const [file] = await Promise.all([page.waitForEvent('download'), download(page).click()]); const content = await bytes(file); expect(content.equals(Buffer.from(patch.dataBase64, 'base64'))).toBe(true); expect(createHash('sha256').update(content).digest('hex')).toBe(patch.sha256); expect(content.toString('latin1')).toContain('GIT binary patch'); expect(file.suggestedFilename()).toBe(gitPatchFilename('R1', { base: data.comparisonBase, target: data.comparisonTarget }));
  const previousRequests = requests; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(download(page)).toBeEnabled(); expect(requests).toBe(previousRequests);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (info.project.name === 'mobile') for (const button of [prepare(page), download(page)]) { const height = (await button.boundingBox())!.height; expect(height).toBeGreaterThanOrEqual(44); expect(height).toBeLessThanOrEqual(80); }
  const folder = `.data/git-patch-visual/${process.env.APP_BASE_PATH ? 'mounted' : 'root'}`; await mkdir(folder, { recursive: true }); await panel(page).evaluate(element => element.scrollIntoView({ block: 'start' })); await page.evaluate(() => scrollBy(0, -110)); await page.screenshot({ path: `${folder}/${info.project.name}-patch-viewport.png` });
  await page.getByRole('button', { name: 'Swap Commits', exact: true }).click(); await expect(download(page)).toBeDisabled(); expect(requests).toBe(previousRequests);
});

test('saved exact patch reopens offline without preparing another pair or reconnect replay', async ({ page, context }) => {
  const data = await fixture(); let requests = 0; page.on('request', value => { if (new URL(value.url()).pathname.endsWith('/compare/patch')) requests++; });
  await open(page); await pair(page, data.base, data.head); await prepared(page); const [first] = await Promise.all([page.waitForEvent('download'), download(page).click()]); const expected = await bytes(first);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await context.setOffline(true);
  try {
    await page.reload(); await expect(panel(page)).toContainText('Saved patch verified'); await expect(prepare(page)).toBeDisabled(); const [saved] = await Promise.all([page.waitForEvent('download'), download(page).click()]); expect((await bytes(saved)).equals(expected)).toBe(true); expect(requests).toBe(1);
    await page.getByRole('button', { name: 'Swap Commits', exact: true }).click(); await expect(download(page)).toBeDisabled(); await expect(panel(page)).toContainText('No verified patch for this exact pair');
    await context.setOffline(false); await expect(prepare(page)).toBeEnabled(); expect(requests).toBe(1);
  } finally { await context.setOffline(false); }
});

test.describe('patch preparation retirement', () => {
  test.use({ serviceWorkers: 'block' });
  test('a late prepared patch cannot enable downloading a newly selected pair', async ({ page }) => {
    const data = await fixture(); await open(page); await pair(page, data.base, data.head);
    let release!: () => void, captured!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { captured = resolve; });
    await page.route('**/api/repositories/R1/compare/patch?**', async route => { const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); });
    try { await prepare(page).click(); await reached; await page.getByRole('button', { name: 'Swap Commits', exact: true }).click(); release(); await page.unrouteAll({ behavior: 'wait' }); await expect(download(page)).toBeDisabled(); await expect(prepare(page)).toBeEnabled(); await expect(panel(page)).not.toContainText('Patch ready'); }
    finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
  test('wrong digest or pair and child export errors retire the export while preserving repository access', async ({ page }) => {
    const data = await fixture(); await open(page); await pair(page, data.base, data.head); await prepared(page);
    for (const kind of ['digest', 'pair', 'limit']) {
      await page.route('**/api/repositories/R1/compare/patch?**', async route => { if (kind === 'limit') { await route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'Complete patch exceeds the export limit.', code: 'GIT_PATCH_TOO_LARGE' }) }); return; } const response = await route.fetch(), patch = await response.json() as GitPatch; if (kind === 'digest') patch.sha256 = '0'.repeat(64); else patch.targetCommit.id = data.base; await route.fulfill({ response, json: patch }); });
      await prepare(page).click(); await expect(panel(page).getByRole('alert')).toBeVisible(); await expect(download(page)).toBeDisabled(); await expect(page.locator('.repository-detail')).toBeVisible(); await page.unrouteAll({ behavior: 'wait' });
    }
  });
  test('patches beyond cache capacity remain downloadable without claiming offline retention', async ({ page }) => {
    const data = await fixture(); await open(page); await pair(page, data.base, data.head);
    await expect(page.locator('.repository-selected-change h3')).toBeVisible();
    const retained = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes('repository:R1:cache')).flatMap(([, value]) => (JSON.parse(value) as { entries: { key: string }[] }).entries.map(item => item.key)));
    const content = Buffer.alloc(1_600_000, 0x61); const sha256 = createHash('sha256').update(content).digest('hex');
    await page.route('**/api/repositories/R1/compare/patch?**', async route => { const response = await route.fetch(); const patch = await response.json() as GitPatch; await route.fulfill({ response, json: { ...patch, bytes: content.length, sha256, dataBase64: content.toString('base64') } }); });
    await prepared(page); await expect(panel(page)).toContainText('exceeds the repository’s offline cache limit'); const [file] = await Promise.all([page.waitForEvent('download'), download(page).click()]); expect(createHash('sha256').update(await bytes(file)).digest('hex')).toBe(sha256);
    const remaining = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes('repository:R1:cache')).flatMap(([, value]) => (JSON.parse(value) as { entries: { key: string }[] }).entries.map(item => item.key)));
    for (const key of retained) expect(remaining).toContain(key);
    await page.unrouteAll({ behavior: 'wait' }); await page.reload(); await expect(download(page)).toBeDisabled(); await expect(prepare(page)).toBeEnabled();
  });
  test('quota failure keeps the verified patch downloadable and clearly labels memory-only retention', async ({ page }) => {
    const data = await fixture(); await open(page); await pair(page, data.base, data.head);
    await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key.includes('repository:R1:cache') && value.includes('git-binary-patch-v1')) throw new DOMException('Storage full', 'QuotaExceededError'); return original.call(this, key, value); }; });
    await prepared(page); await expect(panel(page)).toContainText('ready in memory but could not be saved on this device'); const [file] = await Promise.all([page.waitForEvent('download'), download(page).click()]); expect((await bytes(file)).length).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Swap Commits', exact: true }).click(); await expect(download(page)).toBeDisabled(); await pair(page, data.base, data.head); await expect(download(page)).toBeEnabled(); await expect(panel(page)).toContainText('Retained patch verified'); await expect(panel(page)).toContainText('ready in memory but could not be saved on this device'); await expect(panel(page)).not.toContainText('Saved patch verified');
    await page.reload(); await expect(download(page)).toBeDisabled(); await expect(prepare(page)).toBeEnabled();
  });
});

test('signed-in patch bytes stay in memory and access loss retires the prepared download', async ({ browser }, info) => {
  const baseURL = `http://127.0.0.1:4312${normalizeBasePath(process.env.APP_BASE_PATH)}`;
  const make = () => browser.newContext({ baseURL, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch });
  const aliceContext = await make(), bobContext = await make(), alice = await aliceContext.newPage(), bob = await bobContext.newPage();
  const login = async (page: Page, index: number) => { await page.goto('./#R1'); await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password); await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.locator('.repository-entry')).not.toHaveCount(0); };
  const api = async <T,>(page: Page, path: string, body?: unknown): Promise<T> => page.evaluate(async ({ path, body }) => { const session = await (await fetch(`${location.pathname}api/session`)).json() as { sessionContext: string; csrfToken: string }; const result = await fetch(`${location.pathname}api${path}`, { method: body === undefined ? 'GET' : 'PUT', headers: { 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!result.ok) throw new Error(await result.text()); return result.json(); }, { path, body });
  let original: ObjectAccess | null = null;
  try {
    const data = await fixture(); await login(alice, 0); await login(bob, 1); await alice.getByRole('button', { name: 'Show Commit Changes', exact: true }).click(); await pair(alice, data.base, data.head); await prepared(alice); await expect(panel(alice)).toContainText('signed-in tab only'); expect(await alice.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('git-binary-patch-v1');
    original = await api<ObjectAccess>(bob, '/policies/R1'); const state = await api<AppState>(bob, '/state'); await api(bob, '/policies/R1', { expectedVersion: original.policy.version, spaceId: original.policy.spaceId, ...original.policy.rules, view: { kind: 'principals', principalIds: [state.currentPrincipalId] } });
    await alice.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(panel(alice)).toHaveCount(0); await expect(download(alice)).toHaveCount(0);
  } finally { if (original) { const latest = await api<ObjectAccess>(bob, '/policies/R1'); await api(bob, '/policies/R1', { expectedVersion: latest.policy.version, spaceId: original.policy.spaceId, ...original.policy.rules }); } await aliceContext.close(); await bobContext.close(); }
});
