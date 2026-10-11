import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeBasePath } from '../shared/mount';
import { authAccounts } from './auth-fixture';
import type { ObjectAccess } from '../shared/policy';
import type { AppState } from '../shared/types';
import type { GitBlameFixture } from './git-blame-fixture';

type Fixture = { barePath: string; head: string; base: string; feature: string; blame: GitBlameFixture };
const fixture = async () => JSON.parse(await readFile('.data/e2e-repository-fixture.json', 'utf8')) as Fixture;
const area = (page: Page) => page.locator('.repository-blame');
const origin = (page: Page) => page.getByLabel('Selected line origin', { exact: true });
const entry = (page: Page, name: string) => page.locator('.repository-entry').filter({ has: page.locator('span').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
async function exact(page: Page, commitId: string) { await page.getByLabel('Exact commit ID', { exact: true }).fill(commitId); await page.getByRole('button', { name: 'Open Commit', exact: true }).click(); await expect(page.locator('.repository-commit-id')).toHaveText(commitId); }
async function open(page: Page, data: Fixture, commitId = data.head, path = 'README.md') {
  await page.goto('./#R1'); await expect(page.locator('.repository-commit-id')).toHaveText(data.head);
  if (commitId !== data.head) await exact(page, commitId);
  if (path.includes('/')) { const parts = path.split('/'); for (const part of parts) await entry(page, part).click(); } else await entry(page, path).click();
  await page.getByRole('button', { name: 'Blame', exact: true }).click(); await expect(area(page)).toBeVisible(); await expect(page.getByText('Loading exact line provenance…', { exact: true })).toHaveCount(0);
}
async function line(page: Page, number: number) { await page.getByRole('button', { name: `Show origin of line ${number}`, exact: true }).click(); await expect(origin(page).getByRole('heading')).toHaveText(`Line ${number} origin`); }

test('blame reads exact merge origins and renamed paths with keyboard and mobile navigation', async ({ page }, info) => {
  const data = await fixture(), blame = data.blame; await open(page, data, blame.merge, blame.path);
  await expect(page.locator('.repository-blame-line')).toHaveCount(7);
  expect(await page.locator('.repository-blame-line > pre').allTextContents()).toEqual(blame.content.split('\n').slice(0, -1));
  await expect(origin(page)).toContainText(blame.root); await expect(origin(page)).toContainText(blame.originalPath); await expect(origin(page)).toContainText('Fixture Author');
  const third = page.getByRole('button', { name: 'Show origin of line 3', exact: true }); await third.focus(); await third.press('Enter'); await expect(origin(page)).toContainText(blame.main); await expect(origin(page)).toBeFocused();
  await line(page, 4); await expect(origin(page)).toContainText(blame.feature); await line(page, 7); await expect(origin(page)).toContainText(blame.merge);
  await expect(page.getByLabel('Origin parent').locator('option')).toHaveCount(2); await page.getByLabel('Origin parent').selectOption(blame.feature); await page.getByRole('button', { name: 'Blame Parent at Same Path', exact: true }).click(); await expect(page.locator('.repository-commit-id')).toHaveText(blame.feature); await expect(page.locator('.repository-blame-line')).toHaveCount(6);
  await line(page, 1); await page.getByRole('button', { name: 'Open Origin Source', exact: true }).click(); await expect(page.locator('.repository-commit-id')).toHaveText(blame.root); await expect(page.getByLabel('Repository file source', { exact: true })).toHaveText(blame.rootContent);
  await page.getByRole('button', { name: 'Blame', exact: true }).click(); await expect(area(page)).toContainText('This file has no final newline.'); await page.getByRole('button', { name: 'Show Origin Commit Changes', exact: true }).click(); await expect(page.getByLabel('Comparison base commit')).toHaveValue('empty'); await expect(page.getByLabel('Comparison target commit')).toHaveValue(blame.root);
  await exact(page, data.head); await entry(page, '<script>.txt').click(); await page.getByRole('button', { name: 'Blame', exact: true }).click(); await expect(page.locator('.repository-blame-lines')).toContainText('<script>window.fixtureExecuted = true</script>'); expect(await page.evaluate(() => 'fixtureExecuted' in window)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (info.project.name === 'mobile') {
    expect((await page.getByRole('button', { name: 'Show origin of line 1', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    for (const name of ['Open Origin Source', 'Show Origin Commit Changes']) { const height = (await page.getByRole('button', { name, exact: true }).boundingBox())!.height; expect(height).toBeGreaterThanOrEqual(44); expect(height).toBeLessThanOrEqual(80); }
  }
  const folder = `.data/git-blame-visual/${process.env.APP_BASE_PATH ? 'mounted' : 'root'}`; await mkdir(folder, { recursive: true });
  await origin(page).evaluate(element => element.scrollIntoView({ block: 'start' })); await page.evaluate(() => scrollBy(0, -110)); await page.screenshot({ path: `${folder}/${info.project.name}-blame-viewport.png` });
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  if (info.project.name === 'mobile') { const row = (await page.locator('.repository-blame-line').last().boundingBox())!, footer = (await page.locator('.mobile-tabs').boundingBox())!, header = (await page.locator('.topbar').boundingBox())!; expect(row.y).toBeGreaterThanOrEqual(header.y + header.height); expect(row.y + row.height).toBeLessThanOrEqual(footer.y); }
  await page.screenshot({ path: `${folder}/${info.project.name}-source-viewport.png` });
  await page.screenshot({ path: `${folder}/${info.project.name}.png`, fullPage: true }); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: `${folder}/${info.project.name}-viewport.png` });
});

test('blame explicitly represents empty files and non-text states without attribution', async ({ page }) => {
  const data = await fixture(); await open(page, data, data.head, 'docs/empty.txt'); await expect(area(page)).toContainText('This file is empty. There are no lines to attribute.'); await expect(origin(page)).toHaveCount(0);
  for (const [path, message] of [['binary.dat', 'This file is binary.'], ['invalid.txt', 'This file is not valid UTF-8 text.'], ['oversized.txt', 'This file exceeds the source preview limit.'], ['link', 'This is a symbolic link.'], ['module', 'This is a submodule reference.']]) {
    await exact(page, data.head); await entry(page, path!).click(); await page.getByRole('button', { name: 'Blame', exact: true }).click(); await expect(area(page)).toContainText(message!); await expect(page.locator('.repository-blame-line')).toHaveCount(0); await expect(origin(page)).toHaveCount(0);
  }
});

test('large attribution uses bounded line pages and preserves the exact selected line after reload', async ({ page }) => {
  const data = await fixture(); await open(page, data, data.blame.paged, data.blame.pagedPath);
  await expect(page.locator('.repository-blame-line')).toHaveCount(100); await expect(area(page)).toContainText('Lines 1–100 of 205');
  await page.getByRole('button', { name: 'Next Lines', exact: true }).click(); await expect(area(page)).toContainText('Lines 101–200 of 205'); await expect(page.locator('.repository-blame-line')).toHaveCount(100);
  await page.getByLabel('Provenance line number').fill('205'); await page.getByRole('button', { name: 'Go to Line', exact: true }).click(); await expect(origin(page).getByRole('heading')).toHaveText('Line 205 origin'); await expect(page.locator('.repository-blame-line')).toHaveCount(5); await expect(page.locator('.repository-blame-line > pre').last()).toHaveText('Literal line 205');
  await page.reload(); await expect(origin(page).getByRole('heading')).toHaveText('Line 205 origin'); await expect(page.getByRole('button', { name: 'Next Lines', exact: true })).toBeDisabled();
});

test('reference updates preserve exact blame and visited provenance reopens offline', async ({ page, context }) => {
  const data = await fixture(); await open(page, data); await line(page, 2);
  try {
    await promisify(execFile)('git', ['--git-dir', data.barePath, 'update-ref', 'refs/heads/main', data.feature, data.head]);
    await page.getByRole('button', { name: 'Refresh References', exact: true }).click(); await expect(page.getByLabel('Repository reference').locator('option[value="refs/heads/main"]')).toContainText(data.feature.slice(0, 12)); await expect(page.locator('.repository-commit-id')).toHaveText(data.head);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await context.setOffline(true); await page.reload(); await expect(origin(page).getByRole('heading')).toHaveText('Line 2 origin'); await expect(page.locator('.repository-blame-lines')).toContainText('After the change.');
    await page.getByRole('button', { name: 'Browse Files', exact: true }).click(); await entry(page, '<script>.txt').click(); await page.getByRole('button', { name: 'Blame', exact: true }).click(); await expect(area(page)).toContainText('Line provenance for this exact file has not been saved here.'); await expect(origin(page)).toHaveCount(0); await expect(page.locator('.repository-blame-line')).toHaveCount(0);
  } finally { await context.setOffline(false); await promisify(execFile)('git', ['--git-dir', data.barePath, 'update-ref', 'refs/heads/main', data.head]); }
});

test.describe('blame response retirement', () => {
  test.use({ serviceWorkers: 'block' });
  test('line selection preserves a pending exact commit header read', async ({ page }) => {
    const data = await fixture(); await open(page, data);
    await page.evaluate(() => { for (const [key, value] of Object.entries(localStorage)) { if (!key.includes('repository:R1:cache')) continue; const cache = JSON.parse(value) as { entries: { key: string }[] }; cache.entries = cache.entries.filter(item => !item.key.startsWith('commit:')); localStorage.setItem(key, JSON.stringify(cache)); } });
    let release!: () => void, captured!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { captured = resolve; });
    await page.route(`**/api/repositories/R1/commits/${data.head}`, async route => { const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); });
    try {
      await page.reload(); await reached; await line(page, 2); await expect(page.getByRole('button', { name: 'Show Commit Changes', exact: true })).toBeDisabled(); release(); await page.unrouteAll({ behavior: 'wait' });
      await expect(page.getByRole('button', { name: 'Show Commit Changes', exact: true })).toBeEnabled(); await expect(origin(page).getByRole('heading')).toHaveText('Line 2 origin');
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
  test('late blame cannot replace a newly selected exact file', async ({ page }) => {
    const data = await fixture(); await open(page, data);
    let release!: () => void, captured!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { captured = resolve; });
    await page.route('**/api/repositories/R1/blame?**', async route => { if (new URL(route.request().url()).searchParams.get('path') !== 'README.md') { await route.continue(); return; } const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); });
    try {
      await page.getByRole('button', { name: 'Reload Line Provenance', exact: true }).click(); await reached;
      await page.getByRole('button', { name: 'Browse Files', exact: true }).click(); await entry(page, '<script>.txt').click(); await page.getByRole('button', { name: 'Blame', exact: true }).click(); await expect(page.locator('.repository-blame-lines')).toContainText('fixtureExecuted'); release(); await page.unrouteAll({ behavior: 'wait' }); await expect(page.locator('.repository-blame-lines')).not.toContainText('After the change.');
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
  test('failed and malformed attribution clears source without hiding the repository', async ({ page }) => {
    const data = await fixture(); await open(page, data);
    await page.route('**/api/repositories/R1/blame?**', route => route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'Blame exceeds the complete result limit.', code: 'GIT_BLAME_TOO_LARGE' }) }));
    await page.getByRole('button', { name: 'Reload Line Provenance', exact: true }).click(); await expect(area(page)).toContainText('Blame exceeds the complete result limit.'); await expect(page.locator('.repository-blame-line')).toHaveCount(0); await expect(page.locator('.repository-detail')).toBeVisible();
    await page.unrouteAll({ behavior: 'wait' }); await page.route('**/api/repositories/R1/blame?**', async route => { const response = await route.fetch(); const value = await response.json() as { lines: unknown[] }; value.lines = []; await route.fulfill({ response, json: value }); });
    await page.getByRole('button', { name: 'Reload Line Provenance', exact: true }).click(); await expect(area(page)).toContainText('does not match this exact commit and path'); await expect(page.locator('.repository-blame-line')).toHaveCount(0);
  });
});

test('signed-in blame remains memory-only and retires on repository access loss', async ({ browser }, info) => {
  const baseURL = `http://127.0.0.1:4312${normalizeBasePath(process.env.APP_BASE_PATH)}`;
  const make = () => browser.newContext({ baseURL, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch });
  const aliceContext = await make(), bobContext = await make(), alice = await aliceContext.newPage(), bob = await bobContext.newPage();
  const login = async (page: Page, index: number) => { await page.goto('./#R1'); await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password); await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.locator('.repository-entry')).not.toHaveCount(0); };
  const api = async <T,>(page: Page, path: string, body?: unknown): Promise<T> => page.evaluate(async ({ path, body }) => { const session = await (await fetch(`${location.pathname}api/session`)).json() as { sessionContext: string; csrfToken: string }; const result = await fetch(`${location.pathname}api${path}`, { method: body === undefined ? 'GET' : 'PUT', headers: { 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!result.ok) throw new Error(await result.text()); return result.json(); }, { path, body });
  let original: ObjectAccess | null = null;
  try {
    await login(alice, 0); await login(bob, 1); await entry(alice, 'README.md').click(); await alice.getByRole('button', { name: 'Blame', exact: true }).click(); await expect(alice.locator('.repository-blame-lines')).toContainText('After the change.');
    expect(await alice.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('After the change.');
    original = await api<ObjectAccess>(bob, '/policies/R1'); const state = await api<AppState>(bob, '/state'); await api(bob, '/policies/R1', { expectedVersion: original.policy.version, spaceId: original.policy.spaceId, ...original.policy.rules, view: { kind: 'principals', principalIds: [state.currentPrincipalId] } });
    await alice.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(area(alice)).toHaveCount(0); await expect(alice.locator('.repository-blame-line')).toHaveCount(0);
  } finally { if (original) { const latest = await api<ObjectAccess>(bob, '/policies/R1'); await api(bob, '/policies/R1', { expectedVersion: latest.policy.version, spaceId: original.policy.spaceId, ...original.policy.rules }); } await aliceContext.close(); await bobContext.close(); }
});
