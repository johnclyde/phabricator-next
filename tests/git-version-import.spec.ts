import { lifecycleRequest } from './revision-lifecycle-browser';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { readFile, rename } from 'node:fs/promises';
import type { RevisionDetail, AppState } from '../shared/types';
import type { ObjectAccess } from '../shared/policy';
import { normalizeBasePath } from '../shared/mount';
import { authAccounts } from './auth-fixture';

const fixture = async () => JSON.parse(await readFile('.data/e2e-repository-fixture.json', 'utf8')) as { barePath: string; importCommit: string; importNextCommit: string; importEqualCommit: string; head: string };
const form = (page: Page) => page.getByRole('region', { name: 'Import Git as next version', exact: true });
const api = async (request: APIRequestContext, baseURL: string, path: string, data?: unknown) => { const response = data === undefined ? await request.get(new URL(`api${path}`, baseURL).href) : await request.post(new URL(`api${path}`, baseURL).href, { data }); expect(response.ok(), await response.text()).toBe(true); return response.json(); };
async function create(request: APIRequestContext, baseURL: string, kind = 'code'): Promise<RevisionDetail> { return api(request, baseURL, '/revisions', { title: `Linked ${kind} ${Date.now()}`, kind, repositoryId: 'R1', files: [{ path: 'old-only.txt', content: 'Original review source.\n' }], summary: 'Replace source explicitly.' }); }
async function open(page: Page, detail: RevisionDetail, commitId: string) {
  await page.goto(`./#${detail.revision.id}`); await expect(page.getByRole('button', { name: 'Import Git as Next Version', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Import Git as Next Version', exact: true }).click();
  await expect(form(page).getByRole('heading', { name: 'Import Git as Next Version', exact: true })).toBeFocused();
  expect(await form(page).getByRole('heading').evaluate(element => { const box = element.getBoundingClientRect(); return box.top >= document.querySelector('.topbar')!.getBoundingClientRect().bottom && box.bottom < innerHeight; })).toBe(true);
  await form(page).getByLabel('Git commit to import', { exact: true }).fill(commitId); await form(page).getByLabel('Import message', { exact: true }).fill('Import the reviewed complete Git tree.');
}
for (const kind of ['code', 'paper', 'document']) test(`${kind} review imports a complete pinned Git tree as the next immutable version`, async ({ page, request, baseURL }, info) => {
  const data = await fixture(); const initial = await create(request, baseURL!, kind); const id = initial.revision.id;
  await api(request, baseURL!, `/revisions/${id}/reviews`, { provider: 'local', expectedVersion: 1 });
  await lifecycleRequest(request, baseURL!, id, 'accept_reviewed');
  const before = await api(request, baseURL!, `/revisions/${id}`) as RevisionDetail;
  await open(page, initial, data.importCommit); await expect(form(page)).toContainText('Files absent from the selected commit will be deleted'); await expect(form(page)).toContainText('Version 1');
  const submit = form(page).getByRole('button', { name: 'Replace Source with Git Commit', exact: true }); await submit.evaluate(element => element.scrollIntoView({ block: 'center' }));
  if (info.project.name === 'mobile') expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  if (kind === 'paper') await page.screenshot({ path: info.outputPath('git-version-confirmation.png') });
  await submit.click(); await expect(form(page)).toHaveCount(0); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
  const result = await api(request, baseURL!, `/revisions/${id}`) as RevisionDetail; const current = result.versions.find(v => v.number === 2)!;
  expect(result.revision.status).toBe('needs_review'); expect(result.versions[0]).toEqual(before.versions[0]); expect(result.reviews).toEqual(before.reviews); expect(result.access?.policy).toEqual(before.access?.policy); expect(current.gitSource?.commitId).toBe(data.importCommit); expect(current.files).toHaveLength(8); expect(current.files.some(file => file.path === 'old-only.txt')).toBe(false);
  await expect(page.getByRole('region', { name: 'Git source provenance' })).toContainText(data.importCommit);
  if (kind === 'paper') { const panel = page.getByRole('region', { name: 'Git source provenance' }); await panel.evaluate(element => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - document.querySelector('.topbar')!.getBoundingClientRect().bottom - 12)); await page.screenshot({ path: info.outputPath('git-version-provenance.png') }); }
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('1'); await expect(page.getByLabel('Source file', { exact: true })).toContainText('old-only.txt'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByRole('button', { name: kind === 'code' ? 'Differential' : kind === 'paper' ? 'Papers' : 'Drafts', exact: true }).first().click(); const row = page.locator('.revision-row').filter({ hasText: initial.revision.title }); await expect(row).toContainText('Needs Review'); await expect(row).toContainText('Version 2');
});

test('Git version conflicts preserve submitted pins and offline intent until an explicit new base review', async ({ page, context, request, baseURL }) => {
  const data = await fixture(); const initial = await create(request, baseURL!); await open(page, initial, data.importCommit); const id = initial.revision.id;
  await context.setOffline(true); await expect(form(page).getByRole('button', { name: 'Replace Source with Git Commit' })).toBeDisabled(); await page.reload(); await page.getByRole('button', { name: 'Import Git as Next Version', exact: true }).click(); await expect(form(page).getByLabel('Git commit to import')).toHaveValue(data.importCommit); await context.setOffline(false);
  await api(request, baseURL!, `/revisions/${id}/versions`, { files: [{ path: 'newer.txt', content: 'A concurrent version.' }], message: 'Concurrent update', expectedVersion: 1 });
  const sent: { body: unknown; id: string | undefined }[] = []; await page.route(`**/api/revisions/${id}/import-git`, async route => { sent.push({ body: route.request().postDataJSON(), id: route.request().headers()['idempotency-key'] }); await route.continue(); });
  await form(page).getByRole('button', { name: 'Replace Source with Git Commit' }).click(); await expect(form(page).getByRole('alert')).toBeVisible(); await expect(form(page)).toContainText('Version 1');
  await form(page).getByRole('button', { name: 'Retry Exact Version Import' }).click(); await expect.poll(() => sent.length).toBe(2); expect(sent[1]).toEqual(sent[0]); expect((sent[0]!.body as { expectedVersionId: string }).expectedVersionId).toBe(initial.versions[0]!.id);
  page.once('dialog', dialog => dialog.accept()); await form(page).getByRole('button', { name: 'Review Current Base' }).click(); await expect(form(page)).toContainText('Version 2'); await form(page).getByLabel('Import message').fill('Explicit new base'); await form(page).getByRole('button', { name: 'Replace Source with Git Commit' }).click(); await expect(form(page)).toHaveCount(0); expect(sent[2]!.id).not.toBe(sent[0]!.id); expect((await api(request, baseURL!, `/revisions/${id}`)).revision.currentVersion).toBe(3);
  await page.getByRole('button', { name: 'Import Git as Next Version', exact: true }).click(); await form(page).getByLabel('Git commit to import').fill(data.importNextCommit); await form(page).getByLabel('Import message').fill('Newer draft survives discarded conflict');
  const exported = page.waitForEvent('download'); await form(page).getByRole('button', { name: 'Export Submitted Version Import', exact: true }).click(); expect((await exported).suggestedFilename()).toBe(`${id}-git-version-request.json`); page.once('dialog', dialog => dialog.accept()); await form(page).getByRole('button', { name: 'Discard Submitted Version Import', exact: true }).click(); await expect(form(page).getByLabel('Import message')).toHaveValue('Newer draft survives discarded conflict'); await expect(form(page).getByRole('button', { name: 'Review Submitted Version Import', exact: true })).toHaveCount(0);
});

test('lost Git version response retries after remount and unavailable source without a second version', async ({ page, request, baseURL }) => {
  const data = await fixture(); const initial = await create(request, baseURL!); const id = initial.revision.id; await open(page, initial, data.importCommit);
  const sent: { body: unknown; id: string | undefined }[] = []; let lose = true; await page.route(`**/api/revisions/${id}/import-git`, async route => { sent.push({ body: route.request().postDataJSON(), id: route.request().headers()['idempotency-key'] }); if (lose) { lose = false; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
  await form(page).getByRole('button', { name: 'Replace Source with Git Commit' }).click(); await expect(form(page).getByRole('alert')).toContainText('outcome is not confirmed');
  await rename(data.barePath, `${data.barePath}.version-test-unavailable`);
  try { await page.reload(); await page.getByRole('button', { name: 'Import Git as Next Version', exact: true }).click(); await expect(form(page)).toContainText('Version 1'); await form(page).getByRole('button', { name: 'Retry Exact Version Import' }).click(); await expect(form(page)).toHaveCount(0); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2'); expect(sent[1]).toEqual(sent[0]); expect((await api(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(2); }
  finally { await rename(`${data.barePath}.version-test-unavailable`, data.barePath); }
});

test('late Git version success preserves a newer import draft and comparison while the old source draft stays exportable', async ({ page, request, baseURL }) => {
  const data = await fixture(); const initial = await create(request, baseURL!); const id = initial.revision.id;
  await page.goto(`./#${id}`); await page.getByRole('button', { name: 'Edit & add version', exact: true }).click(); await page.getByRole('textbox', { name: 'File content', exact: true }).fill('Unsaved manual source must survive.'); await page.getByRole('textbox', { name: 'What changed?', exact: true }).fill('Keep the original draft pins');
  await open(page, initial, data.importCommit);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let committed = false;
  await page.route(`**/api/revisions/${id}/import-git`, async route => { const response = await route.fetch(); committed = true; await held; await route.fulfill({ response }); });
  try {
    await form(page).getByRole('button', { name: 'Replace Source with Git Commit' }).click(); await expect.poll(() => committed).toBe(true);
    await form(page).getByRole('button', { name: 'Close Git Import' }).click(); await page.getByRole('button', { name: 'Import Git as Next Version', exact: true }).click(); page.once('dialog', dialog => dialog.accept()); await form(page).getByRole('button', { name: 'Review Current Base' }).click(); await expect(form(page)).toContainText('Version 2'); await form(page).getByLabel('Git commit to import').fill(data.importNextCommit); await form(page).getByLabel('Import message').fill('Newer unsent import intent');
    await page.getByLabel('Version to inspect', { exact: true }).selectOption('1'); await page.getByRole('button', { name: 'Source', exact: true }).click(); release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(form(page).getByLabel('Import message')).toHaveValue('Newer unsent import intent'); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
    await page.getByRole('button', { name: 'Inspect Version 1 Draft', exact: true }).click(); await expect(page.getByRole('textbox', { name: 'File content', exact: true })).toHaveValue('Unsaved manual source must survive.'); await expect(page.getByRole('button', { name: 'Save New Version', exact: true })).toBeDisabled();
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export Version 1 Draft', exact: true }).click(); expect((await download).suggestedFilename()).toBe(`${id}-version-1-draft.json`);
    await page.reload(); await page.getByRole('button', { name: 'Import Git as Next Version', exact: true }).click(); await expect(form(page).getByLabel('Import message')).toHaveValue('Newer unsent import intent'); await expect(page.getByRole('region', { name: 'Earlier source drafts' })).toContainText('Based on version 1');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('an editable review can import when its source repository is read-only to the current member', async ({ browser }, info) => {
  const data = await fixture(); const baseURL = `http://127.0.0.1:4312${normalizeBasePath(process.env.APP_BASE_PATH)}`;
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ baseURL, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch, deviceScaleFactor: info.project.use.deviceScaleFactor })));
  const [alice, bob] = await Promise.all(contexts.map(context => context.newPage()));
  const call = async <T,>(page: Page, path: string, method = 'GET', body?: unknown): Promise<T> => page.evaluate(async ({ path, method, body }) => { const session = await (await fetch(`${location.pathname}api/session`)).json(); const response = await fetch(`${location.pathname}api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!response.ok) throw new Error(await response.text()); return response.json(); }, { path, method, body });
  let original: ObjectAccess | null = null;
  try {
    for (const [index, page] of [alice!, bob!].entries()) { await page.goto('./#R1'); await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password); await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.getByLabel('Exact commit ID')).toBeVisible(); }
    const initial = await call<RevisionDetail>(alice!, '/revisions', 'POST', { title: `Read-only source ${info.project.name}`, kind: 'document', repositoryId: 'R1', files: [{ path: 'draft.txt', content: 'Before import.' }] });
    original = await call<ObjectAccess>(bob!, '/policies/R1'); const state = await call<AppState>(bob!, '/state'); await call(bob!, '/policies/R1', 'PUT', { expectedVersion: original.policy.version, spaceId: original.policy.spaceId, ...original.policy.rules, edit: { kind: 'principals', principalIds: [state.currentPrincipalId] } });
    await alice!.reload(); await open(alice!, initial, data.importCommit); await form(alice!).getByRole('button', { name: 'Replace Source with Git Commit' }).click(); await expect(form(alice!)).toHaveCount(0); await expect(alice!.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
    expect(await alice!.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('Read-only source');
  } finally { if (original) { const current = await call<ObjectAccess>(bob!, '/policies/R1'); await call(bob!, '/policies/R1', 'PUT', { expectedVersion: current.policy.version, spaceId: original.policy.spaceId, ...original.policy.rules }); } await Promise.all(contexts.map(context => context.close())); }
});

test('an active version import never retargets a comparison changed while its committed response is held', async ({ page, request, baseURL }) => {
  const data = await fixture(); const initial = await create(request, baseURL!); const id = initial.revision.id; await open(page, initial, data.importCommit);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let committed = false;
  await page.route(`**/api/revisions/${id}/import-git`, async route => { const response = await route.fetch(); committed = true; await held; await route.fulfill({ response }); });
  try {
    await form(page).getByRole('button', { name: 'Replace Source with Git Commit' }).click(); await expect.poll(() => committed).toBe(true);
    await page.getByRole('button', { name: 'Source', exact: true }).click(); await page.getByLabel('Base version', { exact: true }).selectOption('1');
    release(); await expect(form(page)).toHaveCount(0); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1'); await expect(page.getByLabel('Base version', { exact: true })).toHaveValue('1'); await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveClass(/selected/);
    await expect(page.getByLabel('Version to inspect', { exact: true }).getByRole('option', { name: 'Version 2 · current', exact: true })).toHaveCount(1);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('a stale second tab cannot overwrite a submitted Git version request or its exact retry identity', async ({ page, context, request, baseURL }) => {
  const data = await fixture(); const initial = await create(request, baseURL!); const id = initial.revision.id; await open(page, initial, data.importCommit);
  const second = await context.newPage(); await second.goto(`./#${id}`); await second.getByRole('button', { name: 'Import Git as Next Version', exact: true }).click(); await expect(form(second).getByLabel('Import message')).toHaveValue('Import the reviewed complete Git tree.');
  const sent: { body: unknown; id: string | undefined }[] = []; let lose = true;
  await page.route(`**/api/revisions/${id}/import-git`, async route => { sent.push({ body: route.request().postDataJSON(), id: route.request().headers()['idempotency-key'] }); if (lose) { lose = false; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
  try {
    await form(page).getByRole('button', { name: 'Replace Source with Git Commit' }).click(); await expect(form(page).getByRole('alert')).toContainText('outcome is not confirmed');
    await form(second).getByLabel('Import message').fill('A newer mutable draft from another tab');
    await page.reload(); await page.getByRole('button', { name: 'Import Git as Next Version', exact: true }).click(); await expect(form(page).getByLabel('Import message')).toHaveValue('A newer mutable draft from another tab'); await form(page).getByRole('button', { name: 'Review Submitted Version Import', exact: true }).click();
    await expect(form(page).getByLabel('Import message')).toHaveValue('Import the reviewed complete Git tree.'); await form(page).getByRole('button', { name: 'Retry Exact Version Import' }).click(); await expect(form(page)).toHaveCount(0); expect(sent[1]).toEqual(sent[0]); expect(sent[0]!.id).toBeTruthy();
    await page.getByRole('button', { name: 'Import Git as Next Version', exact: true }).click(); await expect(form(page).getByLabel('Import message')).toHaveValue('A newer mutable draft from another tab'); await expect(form(page).getByRole('button', { name: 'Review Submitted Version Import', exact: true })).toHaveCount(0); expect((await api(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(2);
  } finally { await second.close(); }
});

test('an unsubmitted quarantined version intent can lose its first response then clear exactly its satisfied recovery on retry', async ({ page, request, baseURL }) => {
  const data = await fixture(); const initial = await create(request, baseURL!); const id = initial.revision.id; await open(page, initial, data.importCommit);
  await page.route(`**/api/revisions/${id}`, route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Access changed', code: 'OBJECT_UNAVAILABLE' }) }));
  await page.goto('./#home'); await page.goto(`./#${id}`); await expect(page.getByRole('heading', { name: 'Object unavailable', exact: true })).toBeVisible(); await expect(page.locator('.quarantined-drafts')).toContainText(id);
  await page.unroute(`**/api/revisions/${id}`); await page.reload(); await page.getByRole('button', { name: 'Import Git as Next Version', exact: true }).click(); await form(page).getByRole('button', { name: 'Review Retained Version Import', exact: true }).click();
  const sent: { body: unknown; id: string | undefined }[] = []; let lose = true; await page.route(`**/api/revisions/${id}/import-git`, async route => { sent.push({ body: route.request().postDataJSON(), id: route.request().headers()['idempotency-key'] }); if (lose) { lose = false; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
  await form(page).getByRole('button', { name: 'Replace Source with Git Commit' }).click(); await expect(form(page).getByRole('alert')).toContainText('outcome is not confirmed'); await form(page).getByRole('button', { name: 'Retry Exact Version Import' }).click(); await expect(form(page)).toHaveCount(0); expect(sent[1]).toEqual(sent[0]); await expect(page.locator('.quarantined-drafts')).toHaveCount(0); expect((await api(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(2);
});
