import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeBasePath } from '../shared/mount';
import { authAccounts } from './auth-fixture';
import type { ObjectAccess } from '../shared/policy';
import type { AppState } from '../shared/types';

type Fixture = { barePath: string; head: string; base: string; feature: string; emptyCommit: string };
const fixture = async () => JSON.parse(await readFile('.data/e2e-repository-fixture.json', 'utf8')) as Fixture;
const source = (page: Page) => page.getByLabel('Repository file source', { exact: true });
const entry = (page: Page, name: string) => page.locator('.repository-entry').filter({ has: page.locator('span', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
async function open(page: Page, head: string) { await page.goto('./#R1'); await expect(page.locator('.repository-commit-id')).toHaveText(head); await expect(entry(page, 'README.md')).toBeVisible(); }
async function root(page: Page) { await page.getByRole('button', { name: 'Repository root', exact: true }).click(); await expect(entry(page, 'README.md')).toBeVisible(); }
async function exact(page: Page, commitId: string) { await page.getByLabel('Exact commit ID', { exact: true }).fill(commitId); await page.getByRole('button', { name: 'Open Commit', exact: true }).click(); await expect(page.locator('.repository-commit-id')).toHaveText(commitId); }

test('Diffusion browses exact trees, source, history and explicit special-file states on desktop and mobile', async ({ page, request, baseURL }, info) => {
  const data = await fixture(); await open(page, data.head);
  await page.getByRole('button', { name: 'Open Selected Reference', exact: true }).evaluate(element => element.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: info.outputPath('diffusion-references.png') });
  await entry(page, 'README.md').click(); await expect(source(page)).toContainText('After the change.');
  await page.getByRole('button', { name: 'Commit History', exact: true }).click(); await expect(page.locator('.repository-history')).toContainText('Initial source');
  await page.evaluate(() => { for (const [key, value] of Object.entries(localStorage)) { if (!key.includes('repository:R1:cache')) continue; const cache = JSON.parse(value) as { entries: { key: string }[] }; cache.entries = cache.entries.filter(entry => !entry.key.startsWith('file:')); localStorage.setItem(key, JSON.stringify(cache)); } });
  await page.reload(); await expect(page.locator('.repository-history')).toContainText('Initial source'); await page.getByRole('button', { name: 'Browse Files', exact: true }).click(); await expect(entry(page, 'README.md')).toBeVisible();
  await root(page); await entry(page, 'docs').click(); await entry(page, 'paper.tex').click(); await expect(source(page)).toContainText('\\section{Introduction}');
  await page.getByRole('button', { name: 'docs', exact: true }).click(); await entry(page, 'empty.txt').click(); await expect(page.getByText('This file is empty.', { exact: true })).toBeVisible();
  for (const [path, message] of [['binary.dat', 'This file is binary.'], ['oversized.txt', 'This file exceeds the source preview limit.'], ['invalid.txt', 'This file is not valid UTF-8 text.'], ['link', 'This is a symbolic link.'], ['module', 'This is a submodule reference.']]) {
    await root(page); await entry(page, path!).click(); await expect(page.locator('.repository-blob')).toContainText(message!); await expect(source(page)).toHaveCount(0);
  }
  await root(page); await entry(page, '<script>.txt').click(); await expect(source(page)).toContainText('<script>window.fixtureExecuted = true</script>');
  expect(await page.evaluate(() => 'fixtureExecuted' in window)).toBe(false);
  await root(page); await entry(page, 'unicodé').click(); await entry(page, '研究.md').click(); await expect(source(page)).toHaveText('Unicode source.\n');
  await page.locator('.repository-source').evaluate(element => element.scrollIntoView({ block: 'center' }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (info.project.name === 'mobile') expect((await page.getByRole('button', { name: 'Repository root', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath('diffusion-source.png') });
  await exact(page, data.emptyCommit); await expect(page.getByText('This directory is empty at the selected commit.', { exact: true })).toBeVisible();
  await exact(page, '0'.repeat(40)); await expect(page.locator('.repository-source [role="alert"]')).toBeVisible(); await expect(page.locator('.repository-entry')).toHaveCount(0);
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click(); await page.getByLabel('Workspace command', { exact: true }).fill('open repositories'); await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByLabel('Workspace command', { exact: true }).fill('open R 1'); await page.getByRole('button', { name: 'Run', exact: true }).click(); await expect(page.locator('.repository-detail')).toBeVisible(); await expect(page.locator('.command-feedback')).toContainText('Opened R1');
  const registered = await request.post(new URL('api/repositories', baseURL!).href, { data: { name: `Unconfigured ${Date.now()}`, remoteUrl: 'https://example.invalid/unconfigured.git' } }); expect(registered.ok(), await registered.text()).toBe(true); const repository = await registered.json() as { id: string };
  await page.goto(`./#${repository.id}`); await expect(page.getByRole('heading', { name: 'Source browsing is not configured', exact: true })).toBeVisible(); await expect(page.locator('.repository-source')).toHaveCount(0);
});

test('refreshing branch references does not retarget pinned source and exact loaded snapshots remain usable offline', async ({ page, context }) => {
  const data = await fixture(); await open(page, data.head); await entry(page, 'README.md').click(); await expect(source(page)).toContainText('After the change.');
  try {
    await promisify(execFile)('git', ['--git-dir', data.barePath, 'update-ref', 'refs/heads/main', data.feature, data.head]);
    await page.getByRole('button', { name: 'Refresh References', exact: true }).click(); await expect(page.getByLabel('Repository reference').locator('option[value="refs/heads/main"]')).toContainText(data.feature.slice(0, 12));
    await expect(page.locator('.repository-commit-id')).toHaveText(data.head); await expect(source(page)).toContainText('After the change.');
    await page.getByLabel('Repository reference', { exact: true }).selectOption('refs/heads/main'); await page.getByRole('button', { name: 'Open Selected Reference', exact: true }).click(); await expect(page.locator('.repository-commit-id')).toHaveText(data.feature); await entry(page, 'README.md').click(); await expect(source(page)).toHaveText('Feature source.\n');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(() => Object.entries(localStorage).some(([key, value]) => key.includes('repository:R1:cache') && value.includes('Feature source.')))).toBe(true);
    await context.setOffline(true); await page.reload(); await expect(page.locator('.repository-commit-id')).toHaveText(data.feature); await expect(source(page)).toHaveText('Feature source.\n');
    await exact(page, data.head); await expect(entry(page, 'docs')).toBeVisible(); await entry(page, 'docs').click(); await expect(page.locator('.repository-source')).toContainText('have not been saved here'); await expect(page.locator('.repository-entry')).toHaveCount(0);
  } finally { await context.setOffline(false); await promisify(execFile)('git', ['--git-dir', data.barePath, 'update-ref', 'refs/heads/main', data.head]); }
});

test('a late source response cannot replace a newly selected repository file', async ({ page }) => {
  const data = await fixture(); await open(page, data.head);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let captured!: () => void; const reached = new Promise<void>(resolve => { captured = resolve; });
  await page.route('**/api/repositories/R1/blob?**', async route => { if (new URL(route.request().url()).searchParams.get('path') !== 'README.md') { await route.continue(); return; } const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); });
  try {
    await entry(page, 'README.md').click(); await reached; await root(page); await entry(page, '<script>.txt').click(); await expect(source(page)).toContainText('window.fixtureExecuted');
    release(); await page.unrouteAll({ behavior: 'wait' }); await expect(source(page)).toContainText('window.fixtureExecuted');
    await page.reload(); await expect(source(page)).toContainText('window.fixtureExecuted');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('reloading exact history retires a pending older page and leaves pagination usable', async ({ page }) => {
  const data = await fixture(); await open(page, data.head);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let captured!: () => void; const reached = new Promise<void>(resolve => { captured = resolve; }); let holdNext = true; let finished!: () => void; const drained = new Promise<void>(resolve => { finished = resolve; });
  await page.route('**/api/repositories/R1/history?**', async route => { const url = new URL(route.request().url()); url.searchParams.set('limit', '1'); const response = await route.fetch({ url: url.href }); const holdThis = url.searchParams.has('after') && holdNext; if (holdThis) { holdNext = false; captured(); await held; } await route.fulfill({ response }); if (holdThis) finished(); });
  try {
    await page.getByRole('button', { name: 'Commit History', exact: true }).click(); await expect(page.locator('.repository-history li')).toHaveCount(1);
    await page.getByRole('button', { name: 'Load Older Commits', exact: true }).click(); await reached;
    await page.getByRole('button', { name: 'Reload Exact Snapshot', exact: true }).click(); await expect(page.getByRole('button', { name: 'Load Older Commits', exact: true })).toBeEnabled();
    release(); await drained; await expect(page.getByRole('button', { name: 'Reload Exact Snapshot', exact: true })).toBeEnabled(); await page.unrouteAll({ behavior: 'wait' }); await expect(page.locator('.repository-history li')).toHaveCount(1);
    await page.getByRole('button', { name: 'Load Older Commits', exact: true }).click(); await expect(page.locator('.repository-history li')).toHaveCount(4);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('signed-in source never persists in browser storage and known repository revocation removes rendered snapshots', async ({ browser }, info) => {
  const base = `http://127.0.0.1:4312${normalizeBasePath(process.env.APP_BASE_PATH)}`;
  const make = () => browser.newContext({ baseURL: base, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch, deviceScaleFactor: info.project.use.deviceScaleFactor });
  const aliceContext = await make(); const bobContext = await make(); const alice = await aliceContext.newPage(); const bob = await bobContext.newPage();
  const signed = async (page: Page, index: number) => { await page.goto('./#R1'); await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password); await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(entry(page, 'README.md')).toBeVisible(); };
  const api = async <T,>(page: Page, path: string, body?: unknown): Promise<T> => page.evaluate(async ({ path, body }) => { const prefix = location.pathname; const session = await (await fetch(`${prefix}api/session`)).json() as { sessionContext: string; csrfToken: string }; const response = await fetch(`${prefix}api${path}`, { method: body === undefined ? 'GET' : 'PUT', headers: { 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!response.ok) throw new Error(await response.text()); return response.json(); }, { path, body });
  let original: ObjectAccess | null = null;
  try {
    await signed(alice, 0); await signed(bob, 1); await entry(alice, 'README.md').click(); await expect(source(alice)).toContainText('After the change.');
    expect(await alice.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('After the change.');
    original = await api<ObjectAccess>(bob, '/policies/R1'); const state = await api<AppState>(bob, '/state'); const bobId = state.currentPrincipalId;
    await api(bob, '/policies/R1', { expectedVersion: original.policy.version, spaceId: original.policy.spaceId, view: { kind: 'principals', principalIds: [bobId] }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } });
    await alice.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(alice.locator('.repository-detail')).toHaveCount(0); await expect(source(alice)).toHaveCount(0);
  } finally { if (original) { const latest = await api<ObjectAccess>(bob, '/policies/R1'); await api(bob, '/policies/R1', { expectedVersion: latest.policy.version, spaceId: original.policy.spaceId, ...original.policy.rules }); } await aliceContext.close(); await bobContext.close(); }
});
