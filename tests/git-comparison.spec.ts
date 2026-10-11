import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeBasePath } from '../shared/mount';
import { authAccounts } from './auth-fixture';
import type { ObjectAccess } from '../shared/policy';
import type { AppState } from '../shared/types';

type Fixture = { barePath: string; head: string; base: string; feature: string; emptyCommit: string; importCommit: string; importNextCommit: string; comparisonBase: string; comparisonTarget: string };
const fixture = async () => JSON.parse(await readFile('.data/e2e-repository-fixture.json', 'utf8')) as Fixture;
const area = (page: Page) => page.locator('.repository-comparison');
const row = (page: Page, text: string) => page.locator('.repository-change-row').filter({ has: page.locator('strong', { hasText: new RegExp(`(^| → )${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
async function open(page: Page, target: string) {
  await page.goto('./#R1'); await expect(page.locator('.repository-commit-id')).toHaveText(target);
  await page.getByRole('button', { name: 'Show Commit Changes', exact: true }).click(); await expect(area(page)).toBeVisible();
}
async function compare(page: Page, base: string, target: string) {
  await page.getByLabel('Comparison base commit', { exact: true }).fill(base); await page.getByLabel('Comparison target commit', { exact: true }).fill(target);
  await page.getByRole('button', { name: 'Compare Exact Commits', exact: true }).click();
  await expect(page.locator('.repository-comparison-pair')).toContainText(target); await expect(page.locator('.repository-comparison-pair')).toContainText(base === 'empty' ? 'Empty tree' : base);
}
async function selected(page: Page, name: string) { await row(page, name).click(); await expect(page.locator('.repository-selected-change h3')).toContainText(name); await expect(page.getByText('Loading exact file sides…', { exact: true })).toHaveCount(0); }

test('commit comparisons select exact merge parents and root trees with literal source on desktop and mobile', async ({ page }, info) => {
  const data = await fixture(); await open(page, data.head);
  await expect(area(page)).toContainText('No file changes between these exact trees.');
  const firstParent = (await page.getByLabel('Comparison parent').locator('option').filter({ hasText: 'Parent 1' }).getAttribute('value'))!;
  await expect(page.getByLabel('Comparison parent')).toHaveValue(firstParent);
  await page.getByLabel('Comparison parent').selectOption(data.feature); await selected(page, 'README.md');
  await expect(page.locator('.repository-literal-comparison')).toContainText('Feature source.'); await expect(page.locator('.repository-literal-comparison')).toContainText('After the change.');
  await expect(area(page)).toContainText('comparing parent 2');
  await compare(page, 'empty', data.base); await selected(page, 'README.md'); await expect(page.getByLabel('Base file identity')).toContainText('Absent from this tree.'); await expect(page.locator('.repository-selected-change h3')).toContainText('Added');
  await page.getByRole('button', { name: 'Swap Commits', exact: true }).isDisabled().then(value => expect(value).toBe(true));
  await compare(page, data.base, data.head); await selected(page, '<script>.txt');
  await page.getByRole('button', { name: 'Changes', exact: true }).click(); await expect(page.getByLabel('Comparison base commit')).toHaveValue(data.base);
  await page.getByRole('button', { name: 'Show Commit Changes', exact: true }).click(); await expect(page.getByLabel('Comparison base commit')).toHaveValue(firstParent); await expect(area(page)).toContainText('No file changes between these exact trees.');
  await compare(page, data.base, data.head); await selected(page, '<script>.txt');
  await expect(page.locator('.repository-literal-comparison')).toContainText('<script>window.fixtureExecuted = true</script>'); expect(await page.evaluate(() => 'fixtureExecuted' in window)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (info.project.name === 'mobile') expect((await page.getByRole('button', { name: 'Compare Exact Commits', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const folder = `.data/git-comparison-visual/${process.env.APP_BASE_PATH ? 'mounted' : 'root'}`; await mkdir(folder, { recursive: true });
  await area(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: `${folder}/${info.project.name}.png`, fullPage: true });
  await page.locator('.repository-selected-change').evaluate(element => element.scrollIntoView({ block: 'start' })); await page.evaluate(() => scrollBy(0, -72)); await page.screenshot({ path: `${folder}/${info.project.name}-comparison-viewport.png` });
  await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: `${folder}/${info.project.name}-viewport.png` });
});

test('comparison labels rename, copy, deletion, mode and type changes without treating special entries as text', async ({ page }) => {
  const data = await fixture(); await open(page, data.head); await compare(page, data.comparisonBase, data.comparisonTarget);
  await selected(page, 'rename-after.txt'); await expect(page.locator('.repository-selected-change h3')).toContainText('Renamed'); await expect(page.getByLabel('Base file identity')).toContainText('rename-before.txt'); await expect(page.getByLabel('Target file identity')).toContainText('rename-after.txt');
  await selected(page, 'copy-result.txt'); await expect(page.locator('.repository-selected-change h3')).toContainText('Copied');
  await selected(page, 'deleted.txt'); await expect(page.getByLabel('Target file identity')).toContainText('Absent from this tree.');
  await selected(page, 'executable.sh'); await expect(page.locator('.repository-selected-change')).toContainText('Mode changed: 100644 → 100755. File contents are unchanged.'); await expect(page.locator('.repository-literal-comparison')).toContainText('No text changes.');
  for (const [path, text] of [['type-change', 'Symbolic link. Its target is never followed.'], ['to-directory', 'Directory tree.'], ['binary.dat', 'Binary file.'], ['invalid.txt', 'File is not valid UTF-8.'], ['oversized.txt', 'File exceeds the text preview limit.'], ['module', 'Submodule reference.']]) {
    await selected(page, path!); await expect(page.locator('.repository-comparison-sides')).toContainText(text!); await expect(page.locator('.repository-literal-comparison')).toHaveCount(0);
  }
  await compare(page, data.importCommit, data.importNextCommit); await selected(page, 'README.md');
  await page.getByRole('button', { name: 'Swap Commits', exact: true }).click(); await expect(page.getByLabel('Comparison base commit')).toHaveValue(data.importNextCommit); await expect(page.getByLabel('Comparison target commit')).toHaveValue(data.importCommit); await selected(page, 'added.md'); await expect(page.locator('.repository-selected-change h3')).toContainText('Deleted');
});

test('reference refresh leaves a comparison pinned and exact visited files reopen offline', async ({ page, context }) => {
  const data = await fixture(); await open(page, data.head); await compare(page, data.base, data.head); await selected(page, 'README.md');
  try {
    await promisify(execFile)('git', ['--git-dir', data.barePath, 'update-ref', 'refs/heads/main', data.feature, data.head]);
    await page.getByRole('button', { name: 'Refresh References', exact: true }).click(); await expect(page.getByLabel('Repository reference').locator('option[value="refs/heads/main"]')).toContainText(data.feature.slice(0, 12));
    await expect(page.getByLabel('Comparison target commit')).toHaveValue(data.head); await expect(page.locator('.repository-literal-comparison')).toContainText('After the change.');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await context.setOffline(true); await page.reload();
    await expect(page.getByLabel('Comparison base commit')).toHaveValue(data.base); await expect(page.getByLabel('Comparison target commit')).toHaveValue(data.head); await expect(page.locator('.repository-literal-comparison')).toContainText('After the change.');
    await row(page, 'docs/paper.tex').click(); await expect(area(page)).toContainText('This changed file has not been saved here.'); await expect(page.locator('.repository-literal-comparison')).toHaveCount(0);
  } finally { await context.setOffline(false); await promisify(execFile)('git', ['--git-dir', data.barePath, 'update-ref', 'refs/heads/main', data.head]); }
});

test.describe('comparison response races', () => {
  test.use({ serviceWorkers: 'block' });
  test('swapping commits presents matching editable controls before the new pair can be edited', async ({ page }) => {
    const data = await fixture(); await open(page, data.head); await compare(page, data.base, data.head);
    const firstView = page.evaluate(() => new Promise<{ pair: string[]; inputs: string[] }>((resolve, reject) => {
      const pair = document.querySelector('.repository-comparison-pair')!;
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('The comparison pair did not change.')); }, 5000);
      const observer = new MutationObserver(() => {
        clearTimeout(timeout); observer.disconnect();
        resolve({ pair: [...pair.querySelectorAll('code')].map(element => element.textContent || ''), inputs: ['Comparison base commit', 'Comparison target commit'].map(label => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.value) });
      });
      observer.observe(pair, { subtree: true, childList: true, characterData: true });
    }));
    await page.getByRole('button', { name: 'Swap Commits', exact: true }).click();
    expect(await firstView).toEqual({ pair: [data.head, data.base], inputs: [data.head, data.base] });
    await compare(page, data.base, data.head); await expect(page.locator('.repository-comparison-pair code')).toHaveText([data.base, data.head]);
  });
  test('automatic first-change selection preserves a newly typed exact commit selector', async ({ page }) => {
    const data = await fixture(); await open(page, data.head);
    let release!: () => void, captured!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { captured = resolve; });
    await page.route('**/api/repositories/R1/compare?**', async route => { if (new URL(route.request().url()).searchParams.get('base') !== 'empty') { await route.continue(); return; } const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); });
    try {
      await compare(page, 'empty', data.base); await reached; await page.getByLabel('Exact commit ID', { exact: true }).fill(data.head); release(); await page.unrouteAll({ behavior: 'wait' });
      await expect(page.locator('.repository-selected-change h3')).toContainText('README.md'); await expect(page.getByLabel('Exact commit ID', { exact: true })).toHaveValue(data.head);
      await page.getByRole('button', { name: 'Open Commit', exact: true }).click(); await expect(page.locator('.repository-commit-id')).toHaveText(data.head); await expect(page.locator('.repository-entry')).not.toHaveCount(0);
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
  test('late file and pair responses cannot replace newer exact selections', async ({ page }) => {
    const data = await fixture(); await open(page, data.head); await compare(page, data.base, data.head); await selected(page, '<script>.txt');
    let release!: () => void, captured!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { captured = resolve; });
    await page.route('**/api/repositories/R1/compare/file?**', async route => { if (new URL(route.request().url()).searchParams.get('afterPath') !== 'README.md') { await route.continue(); return; } const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); });
    try {
      await row(page, 'README.md').click(); await reached; await selected(page, '<script>.txt'); release(); await page.unrouteAll({ behavior: 'wait' });
      await expect(page.locator('.repository-literal-comparison')).toContainText('fixtureExecuted'); await expect(page.locator('.repository-literal-comparison')).not.toContainText('After the change.');
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
    let releasePair!: () => void, capturedPair!: () => void; const pairHeld = new Promise<void>(resolve => { releasePair = resolve; }), pairReached = new Promise<void>(resolve => { capturedPair = resolve; });
    await page.route('**/api/repositories/R1/compare?**', async route => { if (new URL(route.request().url()).searchParams.get('base') !== 'empty') { await route.continue(); return; } const response = await route.fetch(); capturedPair(); await pairHeld; await route.fulfill({ response }); });
    try {
      await compare(page, 'empty', data.head); await pairReached; await compare(page, data.feature, data.head); await selected(page, 'README.md'); releasePair(); await page.unrouteAll({ behavior: 'wait' });
      await expect(page.getByLabel('Comparison base commit')).toHaveValue(data.feature); await expect(page.locator('.repository-literal-comparison')).toContainText('Feature source.');
    } finally { releasePair(); await page.unrouteAll({ behavior: 'wait' }); }
  });
  test('unavailable or excessive comparisons clear cached results while keeping the repository visible', async ({ page }) => {
    const data = await fixture(); await open(page, data.head); await compare(page, data.base, data.head); await selected(page, 'README.md');
    await page.route('**/api/repositories/R1/compare?**', route => route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'Comparison exceeds the complete result limit.', code: 'GIT_COMPARISON_TOO_LARGE' }) }));
    await page.getByRole('button', { name: 'Reload Comparison', exact: true }).click(); await expect(area(page)).toContainText('Comparison exceeds the complete result limit.'); await expect(page.locator('.repository-literal-comparison')).toHaveCount(0); await expect(page.locator('.repository-change-row')).toHaveCount(0); await expect(page.locator('.repository-detail')).toBeVisible();
    expect(await page.evaluate(({ base, target }) => Object.entries(localStorage).some(([key, text]) => key.includes('repository:R1:cache') && (JSON.parse(text) as { entries: { key: string }[] }).entries.some(entry => entry.key === JSON.stringify(['comparison', base, target]))), { base: data.base, target: data.head })).toBe(false);
  });
});

test('signed-in comparisons remain memory-only and disappear on repository access loss', async ({ browser }, info) => {
  const baseURL = `http://127.0.0.1:4312${normalizeBasePath(process.env.APP_BASE_PATH)}`;
  const make = () => browser.newContext({ baseURL, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch });
  const aliceContext = await make(), bobContext = await make(), alice = await aliceContext.newPage(), bob = await bobContext.newPage();
  const login = async (page: Page, index: number) => { await page.goto('./#R1'); await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password); await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.locator('.repository-entry')).not.toHaveCount(0); };
  const api = async <T,>(page: Page, path: string, body?: unknown): Promise<T> => page.evaluate(async ({ path, body }) => { const session = await (await fetch(`${location.pathname}api/session`)).json() as { sessionContext: string; csrfToken: string }; const result = await fetch(`${location.pathname}api${path}`, { method: body === undefined ? 'GET' : 'PUT', headers: { 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!result.ok) throw new Error(await result.text()); return result.json(); }, { path, body });
  let original: ObjectAccess | null = null;
  try {
    const data = await fixture(); await login(alice, 0); await login(bob, 1); await alice.getByRole('button', { name: 'Show Commit Changes', exact: true }).click(); await compare(alice, data.base, data.head); await selected(alice, 'README.md');
    expect(await alice.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('After the change.');
    original = await api<ObjectAccess>(bob, '/policies/R1'); const state = await api<AppState>(bob, '/state');
    await api(bob, '/policies/R1', { expectedVersion: original.policy.version, spaceId: original.policy.spaceId, ...original.policy.rules, view: { kind: 'principals', principalIds: [state.currentPrincipalId] } });
    await alice.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(area(alice)).toHaveCount(0); await expect(alice.locator('.repository-literal-comparison')).toHaveCount(0);
  } finally { if (original) { const latest = await api<ObjectAccess>(bob, '/policies/R1'); await api(bob, '/policies/R1', { expectedVersion: latest.policy.version, spaceId: original.policy.spaceId, ...original.policy.rules }); } await aliceContext.close(); await bobContext.close(); }
});
