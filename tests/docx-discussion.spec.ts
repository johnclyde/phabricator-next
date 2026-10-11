import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import type { AppState, RevisionDetail, RevisionVersion, ReviewComment } from '../shared/types';
import type { FileRecord, FileDetail } from '../shared/files';
import type { DocxInspection } from '../shared/docx';
import type { DocxDiscussionExport } from '../shared/docx-discussion';
import { normalizeBasePath } from '../shared/mount';
import { authAccounts } from './auth-fixture';

const fixture = 'tests/fixtures/docx/roundtrip.docx';
const exportPanel = (page: Page) => page.getByLabel('Export Word discussion', { exact: true });
const prepare = (page: Page) => page.getByRole('button', { name: 'Prepare Word Discussion', exact: true });
const download = (page: Page) => page.getByRole('button', { name: 'Download Word Discussion', exact: true });
async function api<T>(request: APIRequestContext, base: string, path: string, body?: unknown): Promise<T> { const response = body === undefined ? await request.get(new URL(`api${path}`, base).href) : await request.post(new URL(`api${path}`, base).href, { data: body, headers: { 'Idempotency-Key': randomUUID() } }); expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>; }
async function upload(request: APIRequestContext, base: string, bytes?: Buffer): Promise<FileRecord> { bytes ??= await readFile(fixture); return api(request, base, '/files', { name: 'passage-discussion.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }); }
async function create(request: APIRequestContext, base: string): Promise<RevisionDetail> { const file = await upload(request, base), state = await api<AppState>(request, base, '/state'); return api(request, base, '/revisions/docx', { title: 'Exact Word passage discussion', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: false, expectedAccessEpoch: state.accessEpoch }); }
function passage(version: RevisionVersion) { const range = version.docx!.projection.editableRanges.find(item => item.text === 'The original result is clear.')!; return { rangeId: range.id, start: 4, end: 12, quote: 'original' }; }
async function addThread(request: APIRequestContext, base: string, detail: RevisionDetail, body = 'Discuss the original wording'): Promise<ReviewComment> { return api(request, base, `/revisions/${detail.revision.id}/comments`, { versionId: detail.versions[0]!.id, body, docxPassage: passage(detail.versions[0]!) }); }
async function selectPassage(page: Page) { await page.locator('.docx-block').filter({ hasText: 'The original result is clear.' }).getByRole('button', { name: 'Discuss passage', exact: true }).click(); await page.getByLabel('Selectable Word passage', { exact: true }).evaluate(element => { const range = document.createRange(); range.setStart(element.firstChild!, 0); range.setEnd(element.firstChild!, 3); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); }); await expect(page.getByLabel('Word passage selection').locator('blockquote')).toHaveText('The'); await page.getByLabel('First character', { exact: true }).fill('5'); await page.getByLabel('Last character', { exact: true }).fill('12'); await expect(page.getByLabel('Word passage selection').locator('blockquote')).toHaveText('original'); await page.getByRole('button', { name: 'Comment on Word Passage', exact: true }).click(); await expect(page.locator('.comment-target blockquote')).toHaveText('original'); }
async function chooseVersion(page: Page, version: RevisionVersion) { await page.getByLabel('Document version', { exact: true }).selectOption(version.id); await expect(page.getByLabel('Document version').locator('option:checked')).toContainText(`Version ${version.number}`); }
async function changedVersion(request: APIRequestContext, base: string, detail: RevisionDetail): Promise<RevisionDetail> { const source = detail.versions[0]!, state = await api<AppState>(request, base, '/state'); return api(request, base, `/revisions/${detail.revision.id}/docx/replace`, { expectedVersion: source.number, expectedVersionId: source.id, expectedContentHash: source.contentHash, expectedAccessEpoch: state.accessEpoch, ...passage(source), replacement: 'revised', message: 'Later exact version' }); }
async function downloadBytes(page: Page): Promise<Buffer> { const result = page.waitForEvent('download'); await download(page).click(); const stream = await (await result).createReadStream(), chunks: Buffer[] = []; for await (const value of stream!) chunks.push(Buffer.from(value)); return Buffer.concat(chunks); }

test('exact Word passage threads reply, resolve, export and reimport as separate classic comments', async ({ page, request, baseURL }, info) => {
  const detail = await create(request, baseURL!), id = detail.revision.id, original = detail.versions[0]!;
  let exports = 0; page.on('request', event => { if (new URL(event.url()).pathname.endsWith('/docx/export-discussion')) exports++; });
  await page.goto(`./#${id}`); await selectPassage(page); await page.getByLabel('Review comment').fill('Question about the original wording'); await page.getByRole('button', { name: 'Add Comment', exact: true }).click();
  const thread = page.locator('.review-thread').filter({ hasText: 'Question about the original wording' }); await expect(thread.locator('.docx-thread-anchor blockquote')).toHaveText('original');
  await thread.getByRole('button', { name: 'Reply', exact: true }).click(); await thread.getByLabel('Reply to this thread').fill('The original package should retain this evidence.'); await thread.getByRole('button', { name: 'Add Reply', exact: true }).click(); await thread.getByRole('button', { name: 'Resolve Thread', exact: true }).click(); await expect(thread.locator('.badge-resolved')).toBeVisible();
  const before = await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`); expect(before.comments[0]?.docxAnchor).toMatchObject({ ...passage(original), versionId: original.id, contentHash: original.contentHash }); expect(before.versions).toHaveLength(1);
  await expect(download(page)).toBeDisabled(); expect(exports).toBe(0); await exportPanel(page).getByRole('checkbox', { name: /Question about the original wording/ }).check(); await prepare(page).click(); await expect(download(page)).toBeEnabled(); const bytes = await downloadBytes(page); expect(exports).toBe(1); expect(bytes).not.toEqual(await readFile(fixture));
  const file = await upload(request, baseURL!, bytes), inspection = await api<DocxInspection>(request, baseURL!, `/files/${file.id}/docx`), importedText = inspection.projection.comments.flatMap(item => item.blocks.map(block => block.text)).join('\n'); expect(inspection.projection.comments.length).toBeGreaterThan(1); expect(importedText).toContain('Please preserve this comment.'); expect(importedText).toContain('Question about the original wording'); expect(importedText).toContain('The original package should retain this evidence.'); expect(importedText.toLowerCase()).toContain('resolved');
  expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).versions[0]!.docx!.sha256).toBe(original.docx!.sha256);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.getByRole('button', { name: 'Import Updated Word File', exact: true }).click(); await expect(page.getByLabel('Word source file').locator(`option[value="${file.id}"]`)).toHaveCount(1); await page.getByLabel('Word source file').selectOption(file.id); await page.getByRole('button', { name: 'Inspect Word Document', exact: true }).click(); await expect(page.getByRole('heading', { name: /Inspected:/ })).toBeVisible(); await page.getByLabel('Version message').fill('Explicit discussion copy reimport'); await page.getByRole('button', { name: 'Import as New Version', exact: true }).click(); await expect(page.getByLabel('Document version').locator('option:checked')).toContainText('Version 2');
  await expect(thread.locator('.docx-thread-anchor')).toContainText('not relocated into version 2'); await expect(exportPanel(page)).toContainText('No passage threads originate in this version'); await thread.getByRole('button', { name: /View original version 1/ }).click(); await expect(page.getByLabel('Word passage selection').locator('blockquote')).toHaveText('original'); await expect(page.getByLabel('Document version')).toHaveValue(original.id);
  await page.getByRole('button', { name: 'Comment on Word Passage', exact: true }).click(); await page.getByLabel('Review comment').fill('Historical original remains available'); await page.getByRole('button', { name: 'Add Comment', exact: true }).click(); const final = await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`); expect(final.comments.find(comment => comment.body === 'Historical original remains available')?.docxAnchor?.versionId).toBe(original.id);
  await exportPanel(page).getByRole('checkbox', { name: /Question about the original wording/ }).check(); await prepare(page).click(); await expect(download(page)).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); if (info.project.name === 'mobile') for (const button of [prepare(page), download(page)]) { const height = (await button.boundingBox())!.height; expect(height).toBeGreaterThanOrEqual(44); expect(height).toBeLessThanOrEqual(80); }
  const folder = `.data/docx-discussion-visual/${process.env.APP_BASE_PATH ? 'mounted' : 'root'}`; await mkdir(folder, { recursive: true }); await exportPanel(page).evaluate(element => element.scrollIntoView({ block: 'start' })); await page.evaluate(() => scrollBy(0, -110)); await page.screenshot({ path: `${folder}/${info.project.name}-discussion-export.png` });
  if (info.project.name === 'mobile') {
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    const footer = (await page.locator('.mobile-tabs').boundingBox())!, header = (await page.locator('.topbar').boundingBox())!;
    for (const target of [download(page), exportPanel(page).getByRole('status')]) {
      const bounds = (await target.boundingBox())!;
      expect(bounds.y).toBeGreaterThanOrEqual(header.y + header.height);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(footer.y);
    }
    await page.screenshot({ path: `${folder}/mobile-discussion-export-bottom.png` });
  }
});

test('offline Word passage drafts retain original quotation while a later version appears', async ({ page, context, request, baseURL }) => {
  const detail = await create(request, baseURL!), original = detail.versions[0]!, id = detail.revision.id; await page.goto(`./#${id}`); await selectPassage(page); await page.getByLabel('Review comment').fill('Retained exact Word draft'); await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await context.setOffline(true);
  try { await page.reload(); await expect(page.getByLabel('Review comment')).toHaveValue('Retained exact Word draft'); await expect(page.locator('.comment-target blockquote')).toHaveText('original'); await expect(prepare(page)).toBeDisabled(); }
  finally { await context.setOffline(false); }
  await changedVersion(request, baseURL!, detail); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByLabel('Document version').locator('option')).toHaveCount(2); await expect(page.getByLabel('Document version')).toHaveValue(original.id); await expect(page.getByLabel('Review comment')).toHaveValue('Retained exact Word draft'); expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).comments).toHaveLength(0); await page.getByRole('button', { name: 'Add Comment', exact: true }).click(); const saved = await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`); expect(saved.comments[0]?.docxAnchor).toMatchObject({ versionId: original.id, ...passage(original) });
});

test.describe('Word discussion export retirement', () => {
  test.use({ serviceWorkers: 'block' });
  test('initial Word document read recovers once after startup authority retires its pending snapshot', async ({ page, request, baseURL }) => {
    const detail = await create(request, baseURL!), id = detail.revision.id;
    let releaseState!: () => void, releaseDetail!: () => void, captured!: () => void, reads = 0, writes = 0;
    const stateHeld = new Promise<void>(resolve => { releaseState = resolve; }), detailHeld = new Promise<void>(resolve => { releaseDetail = resolve; }), reached = new Promise<void>(resolve => { captured = resolve; });
    page.on('request', event => { if (event.method() !== 'GET') writes++; });
    await page.route('**/api/state', async route => { await stateHeld; await route.continue(); });
    await page.route(`**/api/revisions/${id}`, async route => {
      reads++;
      if (reads > 1) { await route.continue(); return; }
      const response = await route.fetch(); captured(); await detailHeld; await route.fulfill({ response });
    });
    try {
      await page.goto(`./#${id}`); await reached; releaseState();
      await expect(page.getByLabel('Word document text')).toContainText('The original result is clear.');
      expect(reads).toBe(2); expect(writes).toBe(0); await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    } finally { releaseState(); releaseDetail(); await page.unrouteAll({ behavior: 'wait' }); }
  });
  test('late export bytes and later thread snapshots cannot enable an obsolete download', async ({ page, request, baseURL }) => {
    const detail = await create(request, baseURL!), id = detail.revision.id; await addThread(request, baseURL!, detail); const next = await changedVersion(request, baseURL!, detail), original = detail.versions[0]!, latest = next.versions.at(-1)!; await page.goto(`./#${id}`); await chooseVersion(page, original); await exportPanel(page).getByRole('checkbox').check();
    let release!: () => void, captured!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { captured = resolve; });
    await page.route(`**/api/revisions/${id}/docx/export-discussion`, async route => { const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); });
    try { await prepare(page).click(); await reached; await chooseVersion(page, latest); release(); await page.unrouteAll({ behavior: 'wait' }); await expect(download(page)).toBeDisabled(); await expect(exportPanel(page)).not.toContainText('Verified Word copy ready'); }
    finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
    await chooseVersion(page, original); await exportPanel(page).getByRole('checkbox').check(); await prepare(page).click(); await expect(download(page)).toBeEnabled(); const fresh = await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`); await api(request, baseURL!, `/revisions/${id}/threads/${fresh.threads![0]!.id}/replies`, { body: 'A newly added reply', viewedVersionId: original.id }); await page.getByRole('button', { name: 'Reload Document', exact: true }).click(); await expect(page.getByText('A newly added reply', { exact: true })).toBeVisible(); await expect(download(page)).toBeDisabled();
  });
  test('digest and stale-thread export errors leave discussion visible and require explicit preparation', async ({ page, request, baseURL }) => {
    const detail = await create(request, baseURL!), id = detail.revision.id; await addThread(request, baseURL!, detail); await page.goto(`./#${id}`); await exportPanel(page).getByRole('checkbox').check();
    await page.route(`**/api/revisions/${id}/docx/export-discussion`, async route => { const response = await route.fetch(), body = await response.json() as DocxDiscussionExport; await route.fulfill({ response, json: { ...body, sha256: '0'.repeat(64) } }); }); await prepare(page).click(); await expect(exportPanel(page).getByRole('alert')).toContainText('SHA-256'); await expect(download(page)).toBeDisabled(); await expect(page.locator('.review-thread')).toBeVisible(); await page.unrouteAll({ behavior: 'wait' });
    await page.route(`**/api/revisions/${id}/docx/export-discussion`, route => route.fulfill({ status: 409, contentType: 'application/json', json: { error: 'The selected discussion changed. Reload before exporting.', code: 'VERSION_CONFLICT' } })); await prepare(page).click(); await expect(exportPanel(page).getByRole('alert')).toContainText('selected discussion changed'); await expect(download(page)).toBeDisabled(); await expect(page.getByLabel('Word document text')).toBeVisible();
  });
});

test('source revocation retires prepared and pending Word copies while preserving authored discussion drafts', async ({ browser }, info) => {
  const basePath = normalizeBasePath(process.env.APP_BASE_PATH), baseURL = `http://127.0.0.1:4312${basePath}`, contexts = await Promise.all([0, 1].map(() => browser.newContext({ baseURL, serviceWorkers: 'block', viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch }))), [alice, bob] = await Promise.all(contexts.map(context => context.newPage()));
  const call = async <T,>(page: Page, path: string, method = 'GET', body?: unknown): Promise<T> => page.evaluate(async ({ path, method, body, basePath }) => { const session = await (await fetch(`${basePath}api/session`)).json(); const response = await fetch(`${basePath}api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!response.ok) throw new Error(await response.text()); return response.json(); }, { path, method, body, basePath });
  let release = () => {}; let downloads = 0;
  try {
    for (const [index, page] of [alice!, bob!].entries()) { await page.goto('./#home'); await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username); await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password); await page.getByRole('button', { name: 'Sign In', exact: true }).click(); await expect(page.getByRole('button', { name: 'Create Task', exact: true })).toBeEnabled(); }
    const bytes = await readFile(fixture), file = await call<FileRecord>(alice!, '/files', 'POST', { name: 'shared-word.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }), state = await call<AppState>(alice!, '/state'); const detail = await call<RevisionDetail>(alice!, '/revisions/docx', 'POST', { title: 'Shared passage discussion', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: true, expectedAccessEpoch: state.accessEpoch }), id = detail.revision.id;
    await call(alice!, `/revisions/${id}/comments`, 'POST', { versionId: detail.versions[0]!.id, body: 'Selected source evidence', docxPassage: passage(detail.versions[0]!) }); await bob!.goto(`./#${id}`); await selectPassage(bob!); await bob!.getByLabel('Review comment').fill('Private retained Word discussion draft'); await exportPanel(bob!).getByRole('checkbox').check(); await prepare(bob!).click(); await expect(download(bob!)).toBeEnabled(); expect(await bob!.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('Private retained Word discussion draft');
    let captured!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { captured = resolve; }); bob!.on('download', () => downloads++); await bob!.route(`**/api/revisions/${id}/docx/export-discussion`, async route => { const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); }); await prepare(bob!).click(); await reached;
    const fileDetail = await call<FileDetail>(alice!, `/files/${file.id}`), binding = fileDetail.attachments.attachments.find(item => item.objectId === id)!; await call(alice!, `/files/${file.id}/attachments`, 'POST', { objectId: id, mode: 'detach', expectedVersion: binding.version }); await bob!.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(bob!.getByRole('heading', { name: 'Object unavailable', exact: true })).toBeVisible(); await expect(exportPanel(bob!)).toHaveCount(0); await expect(bob!.getByRole('heading', { name: 'Drafts set aside after access changed' })).toBeVisible(); release(); await bob!.unrouteAll({ behavior: 'wait' }); expect(downloads).toBe(0);
  } finally { release(); await Promise.all(contexts.map(context => context.close())); }
});
