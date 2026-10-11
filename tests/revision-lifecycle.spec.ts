import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import type { AppState, RevisionDetail } from '../shared/types';
import type { FileRecord } from '../shared/files';
import type { ObjectAccess } from '../shared/policy';
import type { RevisionLifecycleSnapshot } from '../shared/revision-lifecycle';
import type { RevisionAuthorshipSnapshot } from '../shared/revision-authorship';
import { normalizeBasePath } from '../shared/mount';
import { authAccounts } from './auth-fixture';
import { chooseLifecycle, lifecycleAction } from './revision-lifecycle-browser';

const base = normalizeBasePath(process.env.APP_BASE_PATH);
const panel = (page: Page) => page.getByRole('region', { name: 'Revision Lifecycle', exact: true });
const draft = (page: Page) => panel(page).getByRole('region', { name: 'Lifecycle draft', exact: true });
const status = (page: Page) => panel(page).getByTestId('lifecycle-status');
async function api<T>(page: Page, path: string, body?: unknown, method = 'POST'): Promise<T> {
  return page.evaluate(async ({ base, path, body, method }) => { const session = await (await fetch(`${base}api/session`)).json(); const response = await fetch(`${base}api${path}`, { method: body === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!response.ok) throw new Error(await response.text()); return response.json(); }, { base, path, body, method });
}
async function signedIn(browser: Browser, info: TestInfo) {
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:4312${base}`, serviceWorkers: 'block', viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch });
  const page = await context.newPage(); await page.goto('./#home'); await page.getByLabel('Username', { exact: true }).fill(authAccounts[0]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[0]!.password); await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.getByRole('button', { name: 'Create Task', exact: true })).toBeEnabled(); return { context, page };
}
const create = (page: Page, title: string, isDraft = false) => api<RevisionDetail>(page, '/revisions', { title, kind: 'document', draft: isDraft, files: [{ path: 'draft.md', content: 'The exact original manuscript source.\n' }] });
async function exported(page: Page, label: string) { const pending = page.waitForEvent('download'); await panel(page).getByRole('button', { name: label, exact: true }).click(); const chunks: Buffer[] = []; for await (const chunk of (await (await pending).createReadStream())!) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; }
async function prepare(page: Page, action: string, message: string) { await panel(page).getByRole('button', { name: action, exact: true }).click(); await draft(page).getByLabel('Lifecycle message').fill(message); }
async function confirm(page: Page) { await draft(page).getByRole('button', { name: 'Confirm Lifecycle Action', exact: true }).click(); }

test('mobile lifecycle actions preserve historical source, separate planned changes and record trusted history', async ({ page }, info) => {
  await page.goto('./#drafts'); await page.getByRole('button', { name: 'Create Draft', exact: true }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title', { exact: true }).fill('Lifecycle manuscript'); await dialog.getByRole('textbox', { name: /^Draft text/ }).fill('The exact original manuscript source.\n'); await dialog.getByRole('checkbox', { name: 'Start as a draft before requesting review', exact: true }).check(); await dialog.getByRole('button', { name: 'Create Draft', exact: true }).click();
  await expect(status(page)).toHaveText('Draft'); const id = new URL(page.url()).hash.slice(1);
  await chooseLifecycle(page, 'Request Review'); await expect(status(page)).toHaveText('Needs Review');
  await api(page, `/revisions/${id}/versions`, { expectedVersion: 1, files: [{ path: 'draft.md', content: 'A later exact manuscript version.\n' }], message: 'Later source for review' }); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await panel(page).getByRole('button', { name: 'Reload Lifecycle', exact: true }).click();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toContainText('Version 2'); await page.getByLabel('Version to inspect', { exact: true }).selectOption('1');
  const before = await api<RevisionDetail>(page, `/revisions/${id}`);
  await chooseLifecycle(page, 'Plan Changes'); await expect(status(page)).toHaveText('Changes Planned'); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1'); await expect(panel(page)).toContainText('Actions below apply to current source version 2');
  await chooseLifecycle(page, 'Request Review'); await expect(status(page)).toHaveText('Needs Review');
  await api(page, `/revisions/${id}/reviews`, { provider: 'local', expectedVersion: 2 }); await panel(page).getByRole('button', { name: 'Reload Lifecycle', exact: true }).click(); await chooseLifecycle(page, 'Accept Reviewed Version'); await expect(status(page)).toHaveText('Accepted'); await chooseLifecycle(page, 'Close Revision'); await expect(status(page)).toHaveText('Closed');
  await expect(panel(page).getByRole('button', { name: 'Reopen Revision', exact: true })).toBeDisabled(); await expect(panel(page)).toContainText('Reopening is disabled by the operator.'); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1'); expect((await api<RevisionDetail>(page, `/revisions/${id}`)).versions).toEqual(before.versions);
  await panel(page).getByText('Lifecycle History', { exact: true }).click(); await expect(panel(page).locator('.revision-lifecycle-history')).toContainText('Plan Changes'); await expect(panel(page).locator('.revision-lifecycle-history')).toContainText('Source updated'); await expect(panel(page).locator('.revision-lifecycle-history')).toContainText('source version 2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const button = panel(page).getByRole('button', { name: 'Reload Lifecycle', exact: true }); if (info.project.name === 'mobile') { const box = (await button.boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44); expect(box.height).toBeLessThanOrEqual(80); }
  const folder = `.data/revision-lifecycle-visual/${base === '/' ? 'root' : 'mounted'}`; await mkdir(folder, { recursive: true }); await panel(page).evaluate(element => element.scrollIntoView({ block: 'start' })); await page.evaluate(() => scrollBy(0, -110)); await page.screenshot({ path: `${folder}/${info.project.name}-lifecycle.png` });
});

test('Word draft abandon and reclaim preserve its package and never invent review evidence', async ({ browser }, info) => {
  const { context, page } = await signedIn(browser, info);
  try {
    const bytes = await readFile('tests/fixtures/docx/roundtrip.docx'), file = await api<FileRecord>(page, '/files', { name: 'lifecycle.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }), state = await api<AppState>(page, '/state');
    const before = await api<RevisionDetail>(page, '/revisions/docx', { title: 'Word lifecycle draft', draft: true, sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: false, expectedAccessEpoch: state.accessEpoch });
    await page.goto(`./#${before.revision.id}`); await expect(status(page)).toHaveText('Draft'); await chooseLifecycle(page, 'Abandon Revision'); await expect(status(page)).toHaveText('Abandoned'); await chooseLifecycle(page, 'Reclaim Revision'); await expect(status(page)).toHaveText('Draft'); await chooseLifecycle(page, 'Request Review'); await expect(status(page)).toHaveText('Needs Review');
    await expect(panel(page).getByRole('button', { name: 'Accept Reviewed Version', exact: true })).toBeDisabled(); await expect(page.getByLabel('Word document text')).toContainText('The original result is clear.'); const after = await api<RevisionDetail>(page, `/revisions/${before.revision.id}`); expect(after.versions).toEqual(before.versions); expect(after.reviews).toEqual([]);
  } finally { await context.close(); }
});

test('lost lifecycle receipt retries immutable request while retaining a newer explanation', async ({ browser }, info) => {
  const { context, page } = await signedIn(browser, info);
  try {
    const detail = await create(page, 'Lifecycle receipt recovery'), id = detail.revision.id, bodies: unknown[] = [], keys: string[] = []; let once = false;
    await page.route(`**/api/revisions/${id}/lifecycle`, async route => { if (route.request().method() !== 'POST') { await route.continue(); return; } bodies.push(route.request().postDataJSON()); keys.push(route.request().headers()['idempotency-key']!); if (!once) { once = true; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
    await page.goto(`./#${id}`); await prepare(page, 'Plan Changes', 'Original exact explanation'); await confirm(page); await expect(panel(page).getByRole('heading', { name: 'Unconfirmed Lifecycle Change', exact: true })).toBeVisible(); await draft(page).getByLabel('Lifecycle message').fill('Newer explanation to preserve');
    await panel(page).getByRole('button', { name: 'Retry Exact Lifecycle Change', exact: true }).click(); await expect(panel(page).getByRole('heading', { name: 'Unconfirmed Lifecycle Change', exact: true })).toHaveCount(0); await expect(status(page)).toHaveText('Changes Planned'); expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(keys[1]).toBe(keys[0]);
    const retained = await exported(page, 'Export Lifecycle Draft'); expect(retained.message).toBe('Newer explanation to preserve'); expect(retained.expectedLifecycleVersion).toBe(0); await expect(draft(page)).toContainText('keeps its original versions'); expect((await api<RevisionDetail>(page, `/revisions/${id}`)).versions).toEqual(detail.versions);
  } finally { await context.close(); }
});

test('offline lifecycle draft remains pinned and reconnect never changes status automatically', async ({ browser }, info) => {
  const { context, page } = await signedIn(browser, info);
  try {
    const detail = await create(page, 'Offline lifecycle'), id = detail.revision.id; let posts = 0; page.on('request', event => { if (event.method() === 'POST' && new URL(event.url()).pathname.endsWith('/lifecycle')) posts++; });
    await page.goto(`./#${id}`); await prepare(page, 'Plan Changes', 'Offline exact explanation'); await context.setOffline(true); await expect(draft(page).getByRole('button', { name: 'Confirm Lifecycle Action', exact: true })).toBeDisabled(); await expect(panel(page)).toContainText('Saved lifecycle snapshot'); expect((await exported(page, 'Export Lifecycle Draft')).message).toBe('Offline exact explanation'); await context.setOffline(false); await expect(draft(page).getByRole('button', { name: 'Confirm Lifecycle Action', exact: true })).toBeEnabled(); expect(posts).toBe(0); await confirm(page); await expect(status(page)).toHaveText('Changes Planned'); expect(posts).toBe(1);
  } finally { await context.setOffline(false); await context.close(); }
});

test('visited local lifecycle reopens offline and new evidence or author never silently rebases a draft', async ({ page, context, request, baseURL, browser }, info) => {
  const response = await request.post(new URL('api/revisions', baseURL!).href, { data: { title: 'Saved lifecycle', kind: 'document', files: [{ path: 'draft.md', content: 'Retain exact source.\n' }] }, headers: { 'Idempotency-Key': randomUUID() } }); expect(response.ok()).toBe(true); const local = await response.json() as RevisionDetail;
  await page.goto(`./#${local.revision.id}`); await expect(status(page)).toHaveText('Needs Review'); await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await context.setOffline(true);
  try { await page.reload(); await expect(panel(page)).toContainText('Saved lifecycle snapshot'); await expect(status(page)).toHaveText('Needs Review'); } finally { await context.setOffline(false); }
  const auth = await signedIn(browser, info);
  try {
    const detail = await create(auth.page, 'Evidence pinned lifecycle'), id = detail.revision.id;
    await auth.page.goto(`./#${id}`); await prepare(auth.page, 'Plan Changes', 'Pinned before checks'); await api(auth.page, `/revisions/${id}/reviews`, { provider: 'local', expectedVersion: 1 }); await panel(auth.page).getByRole('button', { name: 'Reload Lifecycle', exact: true }).click(); await expect(draft(auth.page)).toContainText('keeps its original versions'); await expect(draft(auth.page).getByRole('button', { name: 'Confirm Lifecycle Action', exact: true })).toBeDisabled();
    const initial = await api<RevisionAuthorshipSnapshot>(auth.page, `/revisions/${id}/authorship`), state = await api<AppState>(auth.page, '/state'), bob = state.principals.find(person => person.username === 'bob')!;
    await api(auth.page, `/revisions/${id}/authorship`, { action: 'assign', authorId: bob.id, message: 'Transfer during lifecycle draft', expectedReviewerVersion: initial.reviewerVersion, expectedLifecycleVersion: initial.lifecycleVersion, expectedAuthorVersion: initial.authorship.version, expectedVersion: initial.head.number, expectedVersionId: initial.head.versionId, expectedContentHash: initial.head.contentHash, expectedAccessEpoch: initial.accessEpoch }); await panel(auth.page).getByRole('button', { name: 'Reload Lifecycle', exact: true }).click(); await expect(panel(auth.page).getByRole('button', { name: 'Plan Changes', exact: true })).toBeDisabled(); expect((await exported(auth.page, 'Export Lifecycle Draft')).expectedAuthorVersion).toBe(0);
  } finally { await auth.context.close(); }
});

test('late status snapshots cannot restore stale actions after a newer status and edit denial holds drafts', async ({ browser }, info) => {
  const { context, page } = await signedIn(browser, info); let release = () => {};
  try {
    const detail = await create(page, 'Late lifecycle state'), id = detail.revision.id; await page.goto(`./#${id}`); await expect(status(page)).toHaveText('Needs Review');
    let reached!: () => void, once = false; const captured = new Promise<void>(resolve => { reached = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/revisions/${id}/lifecycle`, async route => { if (route.request().method() !== 'GET' || once) { await route.continue(); return; } once = true; const response = await route.fetch(); reached(); await held; await route.fulfill({ response }); });
    await panel(page).getByRole('button', { name: 'Reload Lifecycle', exact: true }).click(); await captured; await lifecycleAction((path, body) => api(page, path, body), id, 'abandon'); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(status(page)).toHaveText('Abandoned'); release(); await page.unrouteAll({ behavior: 'wait' }); await expect(status(page)).toHaveText('Abandoned');
    await prepare(page, 'Reclaim Revision', 'Retain after edit revocation');
    const author = await api<RevisionAuthorshipSnapshot>(page, `/revisions/${id}/authorship`), state = await api<AppState>(page, '/state'), bob = state.principals.find(person => person.username === 'bob')!;
    const policy = (await api<ObjectAccess>(page, `/policies/${id}`)).policy; await api(page, `/policies/${id}`, { expectedVersion: policy.version, spaceId: policy.spaceId, view: policy.rules.view, edit: { kind: 'principals', principalIds: [bob.id] }, interact: policy.rules.interact }, 'PUT');
    const refreshedAuthor = await api<RevisionAuthorshipSnapshot>(page, `/revisions/${id}/authorship`);
    await api(page, `/revisions/${id}/authorship`, { action: 'assign', authorId: bob.id, message: '', expectedReviewerVersion: author.reviewerVersion, expectedLifecycleVersion: author.lifecycleVersion, expectedAuthorVersion: author.authorship.version, expectedVersion: author.head.number, expectedVersionId: author.head.versionId, expectedContentHash: author.head.contentHash, expectedAccessEpoch: refreshedAuthor.accessEpoch }); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', { name: 'Drafts set aside after access changed' })).toBeVisible(); await expect(page.locator('.quarantined-drafts')).toContainText('Retain after edit revocation'); await expect(draft(page)).toHaveCount(0); await expect(page.getByRole('heading', { level: 1, name: new RegExp(id) })).toBeVisible();
  } finally { release(); await context.close(); }
});

test('same-epoch external actions and evidence refresh workspace and detail in the correct direction without moving inspected source', async ({ browser }, info) => {
  const { context, page } = await signedIn(browser, info); let release = () => {}; let stateHandled = Promise.resolve();
  try {
    const created = await create(page, 'Remote lifecycle refresh'), id = created.revision.id;
    await api(page, `/revisions/${id}/versions`, { expectedVersion: 1, files: [{ path: 'draft.md', content: 'Exact second version remains selected separately.\n' }], message: 'Second source' });
    await page.goto(`./#${id}`); await expect(status(page)).toHaveText('Needs Review'); await page.getByLabel('Version to inspect', { exact: true }).selectOption('1'); await page.locator('.revision-stack-disclosure > summary').click();
    const selected = page.getByRole('region', { name: 'Selected Stack Revision', exact: true }); await expect(selected).toContainText('Needs Review');
    const initial = await api<RevisionLifecycleSnapshot>(page, `/revisions/${id}/lifecycle`);
    await lifecycleAction((path, body) => api(page, path, body), id, 'plan_changes'); await panel(page).getByRole('button', { name: 'Reload Lifecycle', exact: true }).click();
    await expect(status(page)).toHaveText('Changes Planned'); await expect(page.locator('.revision-title .badge')).toHaveText('Changes Planned'); await expect(selected).toContainText('Changes Planned'); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1'); expect((await api<RevisionLifecycleSnapshot>(page, `/revisions/${id}/lifecycle`)).accessEpoch).toBe(initial.accessEpoch);
    await lifecycleAction((path, body) => api(page, path, body), id, 'request_review'); await panel(page).getByRole('button', { name: 'Reload Lifecycle', exact: true }).click(); await expect(page.locator('.revision-title .badge')).toHaveText('Needs Review');
    const beforeReview = await api<RevisionLifecycleSnapshot>(page, `/revisions/${id}/lifecycle`); await api(page, `/revisions/${id}/reviews`, { provider: 'local', expectedVersion: 2 }); const afterReview = await api<RevisionLifecycleSnapshot>(page, `/revisions/${id}/lifecycle`); expect(afterReview.lifecycle.version).toBe(beforeReview.lifecycle.version); expect(afterReview.accessEpoch).toBe(beforeReview.accessEpoch);
    await panel(page).getByRole('button', { name: 'Reload Lifecycle', exact: true }).click(); await expect(panel(page).getByRole('button', { name: 'Accept Reviewed Version', exact: true })).toBeEnabled(); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
    await page.getByLabel('Version to inspect', { exact: true }).selectOption('2'); await page.getByRole('button', { name: /^Review evidence/ }).click(); await expect(page.getByText(/Local text checks completed for 1 file/)).toBeVisible(); await page.getByLabel('Version to inspect', { exact: true }).selectOption('1');
    await page.goto('./#drafts'); await lifecycleAction((path, body) => api(page, path, body), id, 'abandon');
    let stateRead!: () => void; const observed = new Promise<void>(resolve => { stateRead = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/state', route => {
      stateHandled = (async () => { const response = await route.fetch(); stateRead(); await held; await route.fulfill({ response }); })();
      return stateHandled;
    }, { times: 1 });
    await page.goto(`./#${id}`); await observed; await expect(page.locator('.revision-title .badge')).toHaveText('Abandoned'); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1'); release(); await stateHandled; await expect(status(page)).toHaveText('Abandoned'); await page.goto('./#drafts'); await expect(page.locator('.revision-row').filter({ hasText: 'Remote lifecycle refresh' })).toContainText('Abandoned');
  } finally { release(); await stateHandled; await context.close(); }
});
