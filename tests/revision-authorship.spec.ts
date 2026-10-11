import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import type { AppState, RevisionDetail } from '../shared/types';
import type { ObjectAccess } from '../shared/policy';
import type { FileRecord } from '../shared/files';
import type { RevisionAuthorshipSnapshot } from '../shared/revision-authorship';
import { normalizeBasePath } from '../shared/mount';
import { authAccounts } from './auth-fixture';

const panel = (page: Page) => page.getByRole('region', { name: 'Current Author', exact: true });
const draft = (page: Page) => panel(page).getByRole('region', { name: 'Authorship draft' });
const basePath = normalizeBasePath(process.env.APP_BASE_PATH);
async function signedIn(browser: Browser, info: TestInfo, index = 0) {
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:4312${basePath}`, serviceWorkers: 'block', viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch });
  const page = await context.newPage(); await page.goto('./#home'); await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password); await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.getByRole('button', { name: 'Create Task', exact: true })).toBeEnabled();
  return { context, page };
}
async function api<T>(page: Page, path: string, body?: unknown, method = 'POST'): Promise<T> {
  return page.evaluate(async ({ path, body, method, basePath }) => { const session = await (await fetch(`${basePath}api/session`)).json(); const response = await fetch(`${basePath}api${path}`, { method: body === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!response.ok) throw new Error(await response.text()); return response.json(); }, { path, body, method, basePath });
}
const create = (page: Page, title: string) => api<RevisionDetail>(page, '/revisions', { title, kind: 'document', files: [{ path: 'draft.md', content: 'The exact manuscript source remains unchanged.\n' }] });
async function beginTransfer(page: Page, authorId: string) { await panel(page).getByRole('button', { name: 'Transfer Authorship', exact: true }).click(); await draft(page).getByLabel('New author', { exact: true }).selectOption(authorId); }
async function confirmTransfer(page: Page) { await draft(page).getByRole('button', { name: 'Confirm Transfer', exact: true }).click(); }
async function exported(page: Page, name: string) { const pending = page.waitForEvent('download'); await panel(page).getByRole('button', { name, exact: true }).click(); const chunks: Buffer[] = []; for await (const chunk of (await (await pending).createReadStream())!) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; }

test('transfer and commandeer preserve accepted historical source and distinguish current from original author in Stack', async ({ browser }, info) => {
  const { context, page } = await signedIn(browser, info);
  try {
    const detail = await create(page, 'Authorship manuscript'), id = detail.revision.id, state = await api<AppState>(page, '/state'), bob = state.principals.find(person => person.username === 'bob')!;
    await api(page, `/revisions/${id}/versions`, { expectedVersion: 1, files: [{ path: 'draft.md', content: 'Later exact source.\n' }], message: 'Second version' }); await api(page, `/revisions/${id}/reviews`, { provider: 'local', expectedVersion: 2 }); await api(page, `/revisions/${id}`, { status: 'accepted', expectedVersion: 2 }, 'PATCH'); const before = await api<RevisionDetail>(page, `/revisions/${id}`);
    await page.goto(`./#${id}`); await page.getByLabel('Version to inspect', { exact: true }).selectOption('1'); await expect(panel(page).getByTestId('current-author')).toHaveText('Alice Researcher'); await beginTransfer(page, bob.id); await draft(page).getByLabel('Authorship message').fill('Reviewed handoff with exact source retained.'); await confirmTransfer(page); await expect(panel(page).getByTestId('current-author')).toHaveText('Bob Editor'); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
    const after = await api<RevisionDetail>(page, `/revisions/${id}`); expect(after.versions).toEqual(before.versions); expect(after.reviews).toEqual(before.reviews); expect(after.revision.status).toBe('accepted');
    await page.locator('.revision-stack-disclosure > summary').click(); const selected = page.getByRole('region', { name: 'Selected Stack Revision' }); await expect(selected).toContainText('Current author: Bob Editor'); await expect(selected).toContainText('Original author: Alice Researcher');
    await panel(page).getByRole('button', { name: 'Commandeer This Revision', exact: true }).click(); await draft(page).getByLabel('Authorship message').fill('Taking responsibility for the next review.'); await draft(page).getByRole('button', { name: 'Confirm Commandeer', exact: true }).click(); await expect(panel(page).getByTestId('current-author')).toHaveText('Alice Researcher'); await expect(selected).toContainText('Current author: Alice Researcher'); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
    await panel(page).getByText('Authorship History', { exact: true }).click(); await expect(panel(page).locator('.revision-author-history')).toContainText('commandeered this revision'); await expect(panel(page).locator('.revision-author-history')).toContainText('transferred authorship from Alice Researcher to Bob Editor');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (info.project.name === 'mobile') { const box = (await panel(page).getByRole('button', { name: 'Transfer Authorship', exact: true }).boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44); expect(box.height).toBeLessThanOrEqual(80); }
    const folder = `.data/revision-authorship-visual/${basePath === '/' ? 'root' : 'mounted'}`; await mkdir(folder, { recursive: true }); await panel(page).evaluate(element => element.scrollIntoView({ block: 'start' })); await page.evaluate(() => scrollBy(0, -110)); await page.screenshot({ path: `${folder}/${info.project.name}-authorship.png` });
  } finally { await context.close(); }
});

test('Word author transfer leaves the package, original attribution and discussion unchanged', async ({ browser }, info) => {
  const { context, page } = await signedIn(browser, info);
  try {
    const bytes = await readFile('tests/fixtures/docx/roundtrip.docx'), source = await api<FileRecord>(page, '/files', { name: 'authorship.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }), state = await api<AppState>(page, '/state'), bob = state.principals.find(person => person.username === 'bob')!;
    const detail = await api<RevisionDetail>(page, '/revisions/docx', { title: 'Word author handoff', sourceFile: { fileId: source.id, sha256: source.sha256, bytes: source.bytes }, shareSource: false, expectedAccessEpoch: state.accessEpoch });
    await page.goto(`./#${detail.revision.id}`); await beginTransfer(page, bob.id); await confirmTransfer(page); await expect(panel(page).getByTestId('current-author')).toHaveText('Bob Editor'); await expect(page.getByLabel('Word document text')).toContainText('The original result is clear.');
    const after = await api<RevisionDetail>(page, `/revisions/${detail.revision.id}`); expect(after.versions).toEqual(detail.versions); expect(after.comments).toEqual(detail.comments); await expect(panel(page).locator('dl dd').nth(1)).toHaveText('Alice Researcher');
  } finally { await context.close(); }
});

test('lost receipt retries exact original authorship request while a newer draft survives', async ({ browser }, info) => {
  const { context, page } = await signedIn(browser, info);
  try {
    const detail = await create(page, 'Authorship request recovery'), id = detail.revision.id, state = await api<AppState>(page, '/state'), bob = state.principals.find(person => person.username === 'bob')!;
    const bodies: unknown[] = [], ids: string[] = []; let lost = false;
    await page.route(`**/api/revisions/${id}/authorship`, async route => { if (route.request().method() !== 'POST') { await route.continue(); return; } bodies.push(route.request().postDataJSON()); ids.push(route.request().headers()['idempotency-key']!); if (!lost) { lost = true; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
    await page.goto(`./#${id}`); await beginTransfer(page, bob.id); await draft(page).getByLabel('Authorship message').fill('Original exact request'); await confirmTransfer(page); await expect(panel(page).getByRole('heading', { name: 'Unconfirmed Authorship Change' })).toBeVisible(); await draft(page).getByLabel('Authorship message').fill('Newer retained draft');
    await panel(page).getByRole('button', { name: 'Retry Exact Authorship Change', exact: true }).click(); await expect(panel(page).getByRole('heading', { name: 'Unconfirmed Authorship Change' })).toHaveCount(0); await expect(panel(page).getByTestId('current-author')).toHaveText('Bob Editor'); expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(ids[1]).toBe(ids[0]);
    const retained = await exported(page, 'Export Authorship Draft'); expect(retained.message).toBe('Newer retained draft'); expect(retained.expectedAuthorVersion).toBe(0); await expect(draft(page)).toContainText('keeps its original versions'); expect(JSON.stringify(retained)).not.toContain('Bob Editor');
  } finally { await context.close(); }
});

test('lost handoff receipt can be confirmed after source access is lost without removing a newer draft', async ({ browser }, info) => {
  const { context, page } = await signedIn(browser, info); let release = () => {};
  try {
    const detail = await create(page, 'Private handoff source'), id = detail.revision.id, state = await api<AppState>(page, '/state'), bob = state.principals.find(person => person.username === 'bob')!, policy = (await api<ObjectAccess>(page, `/policies/${id}`)).policy;
    await api(page, `/policies/${id}`, { expectedVersion: policy.version, spaceId: policy.spaceId, view: { kind: 'principals', principalIds: [bob.id] }, edit: { kind: 'principals', principalIds: [bob.id] }, interact: policy.rules.interact }, 'PUT');
    let reached!: () => void, once = false; const captured = new Promise<void>(resolve => { reached = resolve; }), hold = new Promise<void>(resolve => { release = resolve; }); const bodies: unknown[] = [], keys: string[] = [];
    await page.route(`**/api/revisions/${id}/authorship`, async route => { if (route.request().method() !== 'POST') { await route.continue(); return; } bodies.push(route.request().postDataJSON()); keys.push(route.request().headers()['idempotency-key']!); if (!once) { once = true; reached(); await hold; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
    await page.goto(`./#${id}`); await beginTransfer(page, bob.id); await draft(page).getByLabel('Authorship message').fill('Original private handoff'); await confirmTransfer(page); await captured; await draft(page).getByLabel('Authorship message').fill('Newer private draft to preserve'); release();
    await expect(page.getByRole('heading', { name: 'Drafts set aside after access changed' })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Object unavailable', exact: true })).toBeVisible(); await expect(panel(page)).toHaveCount(0);
    const held = page.locator('.quarantined-drafts'); await expect(held).toContainText('Newer private draft to preserve'); await held.getByRole('button', { name: 'Confirm Submitted Authorship Change', exact: true }).click(); await expect(held).toContainText('submitted authorship change'); await expect(held.getByRole('button', { name: 'Confirm Submitted Authorship Change', exact: true })).toHaveCount(0); await expect(held).toContainText('Newer private draft to preserve'); expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(keys[1]).toBe(keys[0]); await expect(page.getByRole('heading', { name: 'Object unavailable', exact: true })).toBeVisible();
  } finally { release(); await context.close(); }
});

test('offline authorship drafts remain pinned and reconnect does not transfer automatically', async ({ browser }, info) => {
  const { context, page } = await signedIn(browser, info);
  try {
    const detail = await create(page, 'Offline authorship draft'), id = detail.revision.id, state = await api<AppState>(page, '/state'), bob = state.principals.find(person => person.username === 'bob')!; let posts = 0;
    page.on('request', event => { if (event.method() === 'POST' && new URL(event.url()).pathname.endsWith('/authorship')) posts++; });
    await page.goto(`./#${id}`); await beginTransfer(page, bob.id); await draft(page).getByLabel('Authorship message').fill('Offline retained explanation'); await context.setOffline(true); await expect(draft(page).getByRole('button', { name: 'Confirm Transfer', exact: true })).toBeDisabled(); await expect(panel(page)).toContainText('Saved authorship snapshot'); expect((await exported(page, 'Export Authorship Draft')).message).toBe('Offline retained explanation'); await context.setOffline(false); await expect(draft(page).getByRole('button', { name: 'Confirm Transfer', exact: true })).toBeEnabled(); expect(posts).toBe(0); await confirmTransfer(page); await expect(panel(page).getByTestId('current-author')).toHaveText('Bob Editor'); expect(posts).toBe(1);
  } finally { await context.setOffline(false); await context.close(); }
});

test('an uncertain handoff can be confirmed after edit access is lost while source remains viewable', async ({ browser }, info) => {
  const { context, page } = await signedIn(browser, info);
  try {
    const detail = await create(page, 'Readable handoff source'), id = detail.revision.id, state = await api<AppState>(page, '/state'), bob = state.principals.find(person => person.username === 'bob')!, policy = (await api<ObjectAccess>(page, `/policies/${id}`)).policy;
    await api(page, `/policies/${id}`, { expectedVersion: policy.version, spaceId: policy.spaceId, view: { kind: 'workspace' }, edit: { kind: 'principals', principalIds: [bob.id] }, interact: policy.rules.interact }, 'PUT');
    const bodies: unknown[] = [], keys: string[] = []; let once = false;
    await page.route(`**/api/revisions/${id}/authorship`, async route => { if (route.request().method() !== 'POST') { await route.continue(); return; } bodies.push(route.request().postDataJSON()); keys.push(route.request().headers()['idempotency-key']!); if (!once) { once = true; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
    await page.goto(`./#${id}`); await beginTransfer(page, bob.id); await draft(page).getByLabel('Authorship message').fill('Exact view-preserving handoff'); await confirmTransfer(page);
    await expect(page.getByRole('heading', { name: 'Drafts set aside after access changed' })).toBeVisible(); await expect(page.getByRole('heading', { level: 1, name: new RegExp(id) })).toBeVisible(); await expect(panel(page).getByTestId('current-author')).toHaveText('Bob Editor'); await expect(panel(page).getByRole('button', { name: 'Transfer Authorship', exact: true })).toHaveCount(0);
    const held = page.locator('.quarantined-drafts'); await held.getByRole('button', { name: 'Confirm Submitted Authorship Change', exact: true }).click(); await expect(held).toContainText('submitted authorship change'); await expect(held.getByRole('button', { name: 'Confirm Submitted Authorship Change', exact: true })).toHaveCount(0); await expect(page.getByRole('heading', { level: 1, name: new RegExp(id) })).toBeVisible(); await expect(panel(page).getByTestId('current-author')).toHaveText('Bob Editor'); await expect(page.getByRole('heading', { name: 'Object unavailable', exact: true })).toHaveCount(0); expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(keys[1]).toBe(keys[0]); expect((await api<RevisionDetail>(page, `/revisions/${id}`)).versions).toEqual(detail.versions);
  } finally { await context.close(); }
});

test('visited local authorship reopens offline and a changed head never silently rebases a draft', async ({ page, context, request, baseURL, browser }, info) => {
  const response = await request.post(new URL('api/revisions', baseURL!).href, { data: { title: 'Local saved author', kind: 'document', files: [{ path: 'draft.md', content: 'Exact source.\n' }] }, headers: { 'Idempotency-Key': randomUUID() } }); expect(response.ok()).toBe(true); const detail = await response.json() as RevisionDetail;
  await page.goto(`./#${detail.revision.id}`); await expect(panel(page).getByTestId('current-author')).not.toHaveText('Unassigned'); await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await context.setOffline(true);
  try { await page.reload(); await expect(panel(page)).toContainText('Saved authorship snapshot'); await expect(panel(page).getByTestId('current-author')).toBeVisible(); } finally { await context.setOffline(false); }
  const auth = await signedIn(browser, info);
  try {
    const doc = await create(auth.page, 'Pinned author source'), id = doc.revision.id, state = await api<AppState>(auth.page, '/state'), bob = state.principals.find(person => person.username === 'bob')!; await auth.page.goto(`./#${id}`); await beginTransfer(auth.page, bob.id); await draft(auth.page).getByLabel('Authorship message').fill('Retained on original source');
    await api(auth.page, `/revisions/${id}/versions`, { expectedVersion: 1, files: [{ path: 'draft.md', content: 'Changed after draft preparation.\n' }], message: 'Concurrent source' }); await panel(auth.page).getByRole('button', { name: 'Reload Current Author', exact: true }).click(); await expect(draft(auth.page)).toContainText('keeps its original versions'); await expect(draft(auth.page).getByRole('button', { name: 'Confirm Transfer', exact: true })).toBeDisabled(); expect((await exported(auth.page, 'Export Authorship Draft')).expectedVersion).toBe(1);
    await api(auth.page, `/revisions/${id}`, { expectedVersion: 2, status: 'closed' }, 'PATCH'); await panel(auth.page).getByRole('button', { name: 'Reload Current Author', exact: true }).click(); await expect(panel(auth.page)).toContainText('Closed revisions can be transferred.'); await expect(panel(auth.page).getByRole('button', { name: 'Transfer Authorship', exact: true })).toBeEnabled(); await expect(panel(auth.page).getByRole('button', { name: 'Commandeer This Revision', exact: true })).toBeDisabled();
  } finally { await auth.context.close(); }
});

test('a late author snapshot cannot restore the previous author after a newer access epoch', async ({ browser }, info) => {
  const { context, page } = await signedIn(browser, info); let release = () => {};
  try {
    const detail = await create(page, 'Late author snapshot'), id = detail.revision.id, state = await api<AppState>(page, '/state'), bob = state.principals.find(person => person.username === 'bob')!, initial = await api<RevisionAuthorshipSnapshot>(page, `/revisions/${id}/authorship`);
    await page.goto(`./#${id}`); await expect(panel(page).getByTestId('current-author')).toHaveText('Alice Researcher');
    let reached!: () => void, once = false; const captured = new Promise<void>(resolve => { reached = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/revisions/${id}/authorship`, async route => { if (route.request().method() !== 'GET' || once) { await route.continue(); return; } once = true; const response = await route.fetch(); reached(); await hold; await route.fulfill({ response }); });
    await panel(page).getByRole('button', { name: 'Reload Current Author', exact: true }).click(); await captured;
    await api(page, `/revisions/${id}/authorship`, { action: 'assign', authorId: bob.id, expectedAuthorVersion: initial.authorship.version, expectedVersion: initial.head.number, expectedVersionId: initial.head.versionId, expectedContentHash: initial.head.contentHash, expectedAccessEpoch: initial.accessEpoch, message: 'Changed while old snapshot was loading' }); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(panel(page).getByTestId('current-author')).toHaveText('Bob Editor'); release(); await page.unrouteAll({ behavior: 'wait' }); await expect(panel(page).getByTestId('current-author')).toHaveText('Bob Editor'); await expect(panel(page).locator('dl dd').nth(1)).toHaveText('Alice Researcher');
  } finally { release(); await context.close(); }
});
