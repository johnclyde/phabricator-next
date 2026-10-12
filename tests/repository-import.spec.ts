import { test, expect, type Page } from '@playwright/test';
import { readFile, rename } from 'node:fs/promises';
import type { RevisionDetail, AppState } from '../shared/types';
import type { ObjectAccess } from '../shared/policy';
import { authAccounts } from './auth-fixture';
import { normalizeBasePath } from '../shared/mount';

const fixture = async () => JSON.parse(await readFile('.data/e2e-repository-fixture.json', 'utf8')) as { barePath: string; head: string; importCommit: string; emptyCommit: string };
const editor = (page: Page) => page.getByRole('region', { name: 'Import pinned commit as review', exact: true });
async function prepare(page: Page, commitId: string, title: string) {
  await page.goto('./#R1'); await page.getByLabel('Exact commit ID', { exact: true }).fill(commitId); await page.getByRole('button', { name: 'Open Commit', exact: true }).click();
  await expect(page.locator('.repository-commit-id').first()).toHaveText(commitId);
  await expect(page.getByRole('button', { name: 'Import as Review', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Import as Review', exact: true }).click();
  await expect(editor(page).getByRole('heading', { name: 'Import as Review', exact: true })).toBeFocused();
  expect(await editor(page).getByRole('heading').evaluate(element => { const box = element.getBoundingClientRect(); return box.top >= document.querySelector('.topbar')!.getBoundingClientRect().bottom && box.bottom < innerHeight; })).toBe(true);
  await editor(page).getByLabel('Review title', { exact: true }).fill(title); await editor(page).getByLabel('Test Plan', { exact: true }).fill('Compare every imported file with the pinned Git commit.');
}

test('explicit complete Git import records immutable executable provenance and later edits retain only the source gate', async ({ page, request, baseURL }, info) => {
  const data = await fixture(); const title = `Imported paper ${info.project.name} ${Date.now()}`;
  await prepare(page, data.importCommit, title); await editor(page).getByLabel('Review kind', { exact: true }).selectOption('paper'); await editor(page).getByLabel('Review summary', { exact: true }).fill('Review this exact text tree.');
  const confirm = editor(page).getByRole('button', { name: 'Import Complete Commit', exact: true }); await confirm.evaluate(element => element.scrollIntoView({ block: 'center' }));
  if (info.project.name === 'mobile') expect((await confirm.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath('git-import-confirmation.png') }); await confirm.click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title); const id = new URL(page.url()).hash.slice(1); expect(id).toMatch(/^P\d+$/);
  const provenance = page.getByRole('region', { name: 'Git source provenance', exact: true }); await expect(provenance).toContainText(data.importCommit);
  await provenance.getByText('Imported file manifest (8 files)', { exact: true }).click(); await expect(provenance).toContainText('Executable text · never executed');
  const result = await request.get(new URL(`api/revisions/${id}`, baseURL!).href); const detail = await result.json() as RevisionDetail;
  expect(detail.versions[0]!.gitSource?.manifest).toHaveLength(8); expect(detail.reviews).toHaveLength(0); expect(detail.versions[0]!.gitSource?.manifest.find(file => file.path === 'tools/check.sh')?.mode).toBe('100755');
  await page.getByLabel('Source file', { exact: true }).selectOption('tools/check.sh'); await page.getByRole('button', { name: 'Source', exact: true }).click(); await expect(page.getByLabel('Source passage text', { exact: true })).toContainText('#!/bin/sh');
  await expect(provenance).toContainText('selected source file was executable'); await provenance.getByText('Imported file manifest (8 files)', { exact: true }).click(); await provenance.evaluate(element => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - document.querySelector('.topbar')!.getBoundingClientRect().bottom - 12)); await page.screenshot({ path: info.outputPath('git-import-provenance.png') });
  expect(await page.evaluate(() => 'fixtureExecuted' in window)).toBe(false); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByRole('button', { name: 'Edit & add version', exact: true }).click(); await page.getByRole('textbox', { name: 'File content', exact: true }).fill('Changed in the review workspace.\n'); await page.getByRole('textbox', { name: 'What changed?', exact: true }).fill('Workspace edit'); await page.getByRole('button', { name: 'Save New Version', exact: true }).click();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2'); await expect(provenance).toHaveCount(0); await expect(page.getByText(/Viewing this review requires access to its source repository/)).toBeVisible();
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('1'); await expect(provenance).toContainText(data.importCommit);
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click(); await page.getByLabel('Workspace command').fill(`open ${id}`); await page.getByRole('button', { name: 'Run', exact: true }).click(); await expect(page.locator('.command-feedback')).toContainText(`Opened ${id}`);
});

test('imports reject the whole unsupported tree, remain offline drafts, and retry lost responses with the exact same key', async ({ page, context, request, baseURL }, info) => {
  const data = await fixture(); const badTitle = `Rejected import ${info.project.name} ${Date.now()}`; await prepare(page, data.head, badTitle);
  await editor(page).getByRole('button', { name: 'Import Complete Commit', exact: true }).click(); await expect(editor(page).getByRole('alert')).toBeVisible();
  const state = await (await request.get(new URL('api/state', baseURL!).href)).json() as AppState; expect(state.revisions.some(item => item.title === badTitle)).toBe(false);
  await page.getByLabel('Exact commit ID', { exact: true }).fill(data.importCommit); await page.getByRole('button', { name: 'Open Commit', exact: true }).click();
  page.once('dialog', dialog => dialog.accept()); await editor(page).getByRole('button', { name: 'Start New Import', exact: true }).click(); const title = `Exact retry ${info.project.name} ${Date.now()}`; await editor(page).getByLabel('Review title').fill(title); await editor(page).getByLabel('Test Plan', { exact: true }).fill('Verify the exact imported tree after recovering this request.');
  await context.setOffline(true); await expect(editor(page).getByRole('button', { name: 'Import Complete Commit', exact: true })).toBeDisabled(); await expect(editor(page)).toContainText('never added to the offline outbox');
  await context.setOffline(false); await expect(editor(page).getByRole('button', { name: 'Import Complete Commit', exact: true })).toBeEnabled();
  const attempts: { key: string | undefined; body: string | null }[] = []; let loseFirst = true; let sourceMoved = false;
  await page.route('**/api/repositories/R1/import-revision', async route => { attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() }); const response = await route.fetch(); if (loseFirst) { loseFirst = false; expect(response.ok(), await response.text()).toBe(true); await route.abort('failed'); } else await route.fulfill({ response }); });
  try {
    await editor(page).getByRole('button', { name: 'Import Complete Commit', exact: true }).click(); await expect(editor(page).getByRole('alert')).toContainText('not confirmed');
    await rename(data.barePath, `${data.barePath}-unavailable`); sourceMoved = true; await page.reload(); await expect(page.getByRole('heading', { name: 'Repository source is unavailable', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Review Saved Import', exact: true }).click(); await expect(editor(page).getByRole('heading')).toBeFocused(); await expect(editor(page).getByLabel('Review title')).toHaveValue(title);
    await editor(page).getByRole('button', { name: 'Retry Exact Import', exact: true }).click(); await expect(page.getByRole('heading', { level: 1 })).toContainText(title); expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
    const fresh = await (await request.get(new URL('api/state', baseURL!).href)).json() as AppState; expect(fresh.revisions.filter(item => item.title === title)).toHaveLength(1);
  } finally { await page.unrouteAll({ behavior: 'wait' }); if (sourceMoved) await rename(`${data.barePath}-unavailable`, data.barePath); }
});

test('a delayed import result cannot close or clear a newer remounted import draft', async ({ page }, info) => {
  const data = await fixture(); await prepare(page, data.importCommit, `Old submission ${info.project.name} ${Date.now()}`);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let captured!: () => void; const reached = new Promise<void>(resolve => { captured = resolve; }); let finished!: () => void; const drained = new Promise<void>(resolve => { finished = resolve; });
  await page.route('**/api/repositories/R1/import-revision', async route => { const response = await route.fetch(); expect(response.ok(), await response.text()).toBe(true); captured(); await held; await route.fulfill({ response }); finished(); });
  try {
    await editor(page).getByRole('button', { name: 'Import Complete Commit', exact: true }).click(); await reached; await page.getByRole('button', { name: 'Close Import', exact: true }).click(); await page.getByRole('button', { name: 'Import as Review', exact: true }).click();
    page.once('dialog', dialog => dialog.accept()); await editor(page).getByRole('button', { name: 'Start New Import', exact: true }).click(); await editor(page).getByLabel('Review title').fill('Newer unsaved import'); await editor(page).getByLabel('Review summary').fill('Keep this exact draft.');
    release(); await drained; await page.unrouteAll({ behavior: 'wait' }); await expect(editor(page)).toBeVisible(); await expect(editor(page).getByLabel('Review title')).toHaveValue('Newer unsaved import'); await expect(editor(page).getByLabel('Review summary')).toHaveValue('Keep this exact draft.');
    await page.reload(); await page.getByRole('button', { name: 'Import as Review', exact: true }).click(); await expect(editor(page).getByLabel('Review title')).toHaveValue('Newer unsaved import');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('observed repository denial removes linked review source and comparison before workspace refresh while retaining drafts', async ({ browser }, info) => {
  const data = await fixture(); const base = `http://127.0.0.1:4312${normalizeBasePath(process.env.APP_BASE_PATH)}`;
  const make = () => browser.newContext({ baseURL: base, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch, deviceScaleFactor: info.project.use.deviceScaleFactor });
  const aliceContext = await make(); const bobContext = await make(); const alice = await aliceContext.newPage(); const bob = await bobContext.newPage();
  const sign = async (page: Page, index: number) => { await page.goto('./#R1'); await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password); await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.getByLabel('Exact commit ID')).toBeVisible(); };
  const api = async <T,>(page: Page, path: string, body?: unknown): Promise<T> => page.evaluate(async ({ path, body }) => { const prefix = location.pathname; const session = await (await fetch(`${prefix}api/session`)).json() as { sessionContext: string; csrfToken: string }; const response = await fetch(`${prefix}api${path}`, { method: body === undefined ? 'GET' : 'PUT', headers: { 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!response.ok) throw new Error(await response.text()); return response.json(); }, { path, body });
  let original: ObjectAccess | null = null;
  try {
    await sign(alice, 0); await sign(bob, 1); await prepare(alice, data.importCommit, `Private linked review ${info.project.name}`); await editor(alice).getByRole('button', { name: 'Import Complete Commit', exact: true }).click(); await expect(alice.getByRole('region', { name: 'Git source provenance' })).toBeVisible(); const id = new URL(alice.url()).hash.slice(1);
    await alice.getByRole('button', { name: 'Edit & add version', exact: true }).click(); await alice.getByRole('textbox', { name: 'File content', exact: true }).fill('Unsubmitted private edit');
    expect(await alice.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('Unsubmitted private edit');
    // Prevent a full workspace refresh from discovering the loss: the direct
    // repository response must invalidate its already-known dependent review.
    await alice.route('**/api/state', route => route.abort('failed'));
    original = await api<ObjectAccess>(bob, '/policies/R1'); const state = await api<AppState>(bob, '/state'); await api(bob, '/policies/R1', { expectedVersion: original.policy.version, spaceId: original.policy.spaceId, view: { kind: 'principals', principalIds: [state.currentPrincipalId] }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } });
    await alice.goto('./#R1'); await expect(alice.getByRole('heading', { name: 'Object unavailable', exact: true })).toBeVisible(); await alice.goto(`./#${id}`); await expect(alice.getByRole('heading', { name: 'Object unavailable', exact: true })).toBeVisible(); await expect(alice.locator('.git-provenance,.literal-line-diff,.source-passages,.version-editor')).toHaveCount(0);
    await expect(alice.locator('.quarantined-drafts')).toContainText(id); await alice.locator('.quarantined-drafts').getByText('Inspect your saved draft', { exact: true }).click(); await expect(alice.locator('.quarantined-drafts')).toContainText('Unsubmitted private edit');
  } finally { await alice.unrouteAll({ behavior: 'wait' }); if (original) { const latest = await api<ObjectAccess>(bob, '/policies/R1'); await api(bob, '/policies/R1', { expectedVersion: latest.policy.version, spaceId: original.policy.spaceId, ...original.policy.rules }); } await aliceContext.close(); await bobContext.close(); }
});

test('failed-write revision drafts preserve both tab copies on remount, source revocation and explicit recovery discard', async ({ page, request, baseURL }, info) => {
  const data = await fixture(); const response = await request.post(new URL('api/repositories/R1/import-revision', baseURL!).href, { data: { testPlan: 'Fixture verification plan.', commitId: data.importCommit, kind: 'code', title: `Quota retained import ${info.project.name}` } }); expect(response.ok(), await response.text()).toBe(true); const detail = await response.json() as RevisionDetail; const id = detail.revision.id;
  await page.goto(`./#${id}`); await page.getByRole('button', { name: 'Edit & add version', exact: true }).click(); const field = page.getByRole('textbox', { name: 'File content', exact: true });
  const key = await page.evaluate(id => { const key = Object.keys(localStorage).find(key => key.includes(`version-draft:${id}:1`)); if (!key) throw new Error('Expected initialized version draft'); const original = Storage.prototype.setItem; (window as unknown as { restoreDraftStorage: () => void }).restoreDraftStorage = () => { Storage.prototype.setItem = original; }; Storage.prototype.setItem = function(name, value) { if (name === key) throw new DOMException('Quota exceeded', 'QuotaExceededError'); original.call(this, name, value); }; return key; }, id);
  await field.fill('Newest text retained only in this tab'); await expect(page.locator('.version-editor')).toContainText('Storage is unavailable or another saved copy changed');
  await page.evaluate(key => { (window as unknown as { restoreDraftStorage: () => void }).restoreDraftStorage(); const durable = JSON.parse(localStorage.getItem(key)!); durable.files[0].content = 'Different newer draft saved by another tab'; localStorage.setItem(key, JSON.stringify(durable)); }, key);
  await page.getByRole('button', { name: 'Close editor', exact: true }).click(); await page.getByRole('button', { name: 'Edit & add version', exact: true }).click(); await expect(field).toHaveValue('Newest text retained only in this tab'); expect(await page.evaluate(key => localStorage.getItem(key), key)).toContain('Different newer draft saved by another tab');
  await page.route('**/api/repositories/R1', route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'OBJECT_UNAVAILABLE', error: 'Unavailable' }) }));
  await page.goto('./#R1'); await expect(page.getByRole('heading', { name: 'Object unavailable', exact: true })).toBeVisible(); await expect(page.locator('.quarantined-draft')).toHaveCount(2);
  await page.unrouteAll({ behavior: 'wait' }); await page.reload(); await page.goto(`./#${id}`); await page.getByRole('button', { name: 'Edit & add version', exact: true }).click(); await expect(field).toHaveCount(0); await expect(page.locator('.quarantined-draft')).toHaveCount(2);
  const saved = await page.locator('.quarantined-draft pre').allTextContents(); expect(saved.join('\n')).toContain('Newest text retained only in this tab'); expect(saved.join('\n')).toContain('Different newer draft saved by another tab');
  for (let remaining = 2; remaining > 0; remaining--) { page.once('dialog', dialog => dialog.accept()); await page.locator('.quarantined-draft').first().getByRole('button', { name: 'Discard Draft', exact: true }).click(); await expect(page.locator('.quarantined-draft')).toHaveCount(remaining - 1); }
  await expect(field).toBeVisible(); await expect(field).not.toHaveValue('Newest text retained only in this tab'); await expect(field).not.toHaveValue('Different newer draft saved by another tab');
});

test('late initial references never replace an exact commit being entered for import', async ({ page }) => {
  const data = await fixture(); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let captured!: () => void; const reached = new Promise<void>(resolve => { captured = resolve; });
  await page.route('**/api/repositories/R1/refs', async route => { const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); });
  try {
    await page.goto('./#R1'); await reached; await page.getByLabel('Exact commit ID', { exact: true }).fill(data.importCommit); release(); await expect(page.locator('.repository-commit-id').first()).toHaveText(data.head);
    await expect(page.getByLabel('Exact commit ID', { exact: true })).toHaveValue(data.importCommit); await page.getByRole('button', { name: 'Open Commit', exact: true }).click(); await expect(page.locator('.repository-commit-id').first()).toHaveText(data.importCommit); await expect(page.getByRole('button', { name: 'Import as Review', exact: true })).toBeEnabled();
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('opening the already pinned commit does not cancel its pending source identity read', async ({ page }) => {
  const data = await fixture(); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let captured!: () => void; const reached = new Promise<void>(resolve => { captured = resolve; });
  await page.route(`**/api/repositories/R1/commits/${data.head}`, async route => { const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); });
  try {
    await page.goto('./#R1'); await reached; await expect(page.getByLabel('Exact commit ID', { exact: true })).toHaveValue(data.head); await page.getByRole('button', { name: 'Open Commit', exact: true }).click(); release(); await expect(page.getByRole('button', { name: 'Import as Review', exact: true })).toBeEnabled();
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('a quarantined submitted import resumes explicitly after repository access returns without needing source browsing', async ({ page, request, baseURL }, info) => {
  const data = await fixture(); const title = `Retained source request ${info.project.name} ${Date.now()}`; await prepare(page, data.importCommit, title);
  const attempts: { key: string | undefined; body: string | null }[] = []; let loseFirst = true;
  await page.route('**/api/repositories/R1/import-revision', async route => { attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() }); const response = await route.fetch(); expect(response.ok(), await response.text()).toBe(true); if (loseFirst) { loseFirst = false; await route.abort('failed'); } else await route.fulfill({ response }); });
  let denied = true;
  try {
    await editor(page).getByRole('button', { name: 'Import Complete Commit', exact: true }).click(); await expect(editor(page).getByRole('alert')).toContainText('not confirmed');
    await page.route('**/api/repositories/R1', async route => { if (denied) await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'OBJECT_UNAVAILABLE', error: 'Unavailable' }) }); else { const response = await route.fetch(); const data = await response.json(); await route.fulfill({ response, json: { ...data, observer: { state: 'unavailable', message: 'Source is temporarily unavailable.' } } }); } });
    await page.getByRole('button', { name: 'Reload Repository', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Object unavailable', exact: true })).toBeVisible(); await expect(page.locator('.quarantined-drafts')).toContainText('R1'); expect(attempts).toHaveLength(1);
    denied = false; await page.getByRole('button', { name: 'Reload workspace', exact: true }).evaluate(button => (button as HTMLButtonElement).click()); await expect(page.getByRole('heading', { name: 'Repository source is unavailable', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Review Saved Import', exact: true }).click(); await editor(page).getByRole('button', { name: 'Review Retained Import', exact: true }).click(); await expect(editor(page).getByRole('heading')).toBeFocused(); await expect(editor(page).getByLabel('Review title')).toHaveValue(title); expect(attempts).toHaveLength(1);
    await editor(page).getByRole('button', { name: 'Retry Exact Import', exact: true }).click(); await expect(page.getByRole('heading', { level: 1 })).toContainText(title); expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
    const fresh = await (await request.get(new URL('api/state', baseURL!).href)).json() as AppState; expect(fresh.revisions.filter(item => item.title === title)).toHaveLength(1); await expect(page.locator('.quarantined-draft')).toHaveCount(0);
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});
