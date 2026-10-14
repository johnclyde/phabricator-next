import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { fromBufferPromise } from 'yauzl';
import { ZipFile } from 'yazl';
import type { FileRecord } from '../shared/files';
import type { AppState, RevisionDetail } from '../shared/types';
import { normalizeBasePath } from '../shared/mount';
async function source(): Promise<Buffer> {
  const bytes = await readFile('tests/fixtures/docx/roundtrip.docx'), input = await fromBufferPromise(bytes), zip = new ZipFile(), chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(Buffer.from(chunk))); zip.outputStream.once('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.once('error', reject); });
  try { for await (const entry of input.eachEntry()) { const content: Buffer[] = []; for await (const chunk of await input.openReadStreamPromise(entry)) content.push(Buffer.from(chunk)); let data = Buffer.concat(content); if (entry.fileName === 'word/document.xml') data = Buffer.from(data.toString().replace('<w:body>', '<w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Alpha </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>beta argument.</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph evidence.</w:t></w:r></w:p>')); zip.addBuffer(data, entry.fileName); } } finally { input.close(); }
  zip.end(); return done;
}
async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> { const url = new URL(`api${path}`, baseURL).href, response = body === undefined ? await request.get(url) : await request.post(url, { data: body, headers: { 'Idempotency-Key': randomUUID() } }); expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>; }
async function create(request: APIRequestContext, baseURL: string): Promise<RevisionDetail> {
  const bytes = await source(), file = await api<FileRecord>(request, baseURL, '/files', { name: 'multi-paragraph.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }), state = await api<AppState>(request, baseURL, '/state');
  return api(request, baseURL, '/revisions/docx', { title: 'Word multi-passage draft', testPlan: 'Review each original passage and exported tracked changes.', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, expectedAccessEpoch: state.accessEpoch, shareSource: false });
}
async function add(page: Page, paragraph: string, start: number, end: number, replacement: string) {
  const select = page.getByLabel('Paragraph for next edit'), value = await select.locator('option').filter({ hasText: paragraph }).getAttribute('value'); await select.selectOption(value!);
  await page.getByLabel('Passage start (character)').fill(String(start)); await page.getByLabel('Passage end (character)').fill(String(end)); await page.getByLabel('Next replacement text').fill(replacement);
  await page.getByRole('button', { name: 'Add Passage to Edit Set', exact: true }).click();
}
async function prepare(page: Page) {
  await page.getByRole('button', { name: 'Edit Multiple Passages', exact: true }).click();
  await add(page, 'Alpha beta argument.', 1, 10, 'Reviewed evidence'); await add(page, 'Second paragraph evidence.', 1, 6, 'Updated'); await page.getByLabel('Edit set message').fill('Clarified both arguments');
}
test('Word edit sets preview complete cross-run and multi-paragraph changes and save one tracked package', async ({ page, request, baseURL }, info) => {
  const initial = await create(request, baseURL!), id = initial.revision.id; await page.goto(`./#${id}`); await prepare(page);
  const preview = page.getByLabel('Complete Word edit set'); await expect(preview.getByLabel('Word edit 1', { exact: true })).toContainText('Alpha beta'); await expect(preview.getByLabel('Word edit 1', { exact: true })).toContainText('Reviewed evidence'); await expect(preview.getByLabel('Word edit 2', { exact: true })).toContainText('Second'); await expect(preview.getByLabel('Word edit 2', { exact: true })).toContainText('Updated');
  expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await preview.scrollIntoViewIfNeeded(); const directory = `.data/docx-batch-visual/${normalizeBasePath(process.env.APP_BASE_PATH) === '/' ? 'root' : 'mounted'}`; await mkdir(directory, { recursive: true }); await page.screenshot({ path: `${directory}/${info.project.name}.png` });
  await page.getByRole('button', { name: 'Save All 2 Tracked Edits', exact: true }).click(); await expect(page.getByLabel('Document version').locator('option:checked')).toContainText('Version 2');
  const saved = await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`); expect(saved.versions).toHaveLength(2); expect(saved.versions[0]).toEqual(initial.versions[0]); expect(saved.versions[1]!.docxOperation?.kind).toBe('replace-batch');
  await expect(page.locator('.docx-reading ins').filter({ hasText: 'Reviewed evidence' })).toHaveCount(1); await expect(page.locator('.docx-reading ins').filter({ hasText: 'Updated' })).toHaveCount(1);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download Word Version 2', exact: true }).click(); const stream = await (await download).createReadStream(), chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk)); expect(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')).toBe(saved.versions[1]!.docx!.sha256);
});

test('Word edit sets keep exact lost receipts and newer drafts without reconnect submission', async ({ page, context, request, baseURL }) => {
  const initial = await create(request, baseURL!), id = initial.revision.id, sent: { key?: string; body: unknown }[] = []; let lose = true;
  await context.route(`**/api/revisions/${id}/docx/replace-batch`, async route => { sent.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() }); const result = await route.fetch(); if (lose) { lose = false; return route.abort('failed'); } return route.fulfill({ response: result }); });
  await page.goto(`./#${id}`); await prepare(page); await page.getByRole('button', { name: 'Save All 2 Tracked Edits', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Unconfirmed Word Document Change', exact: true })).toBeVisible();
  await page.getByLabel('Edit set message').fill('Newer unsent draft message'); await context.setOffline(true); await context.setOffline(false); await expect(page.getByRole('button', { name: 'Retry Exact Word Change', exact: true })).toBeEnabled(); expect(sent).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry Exact Word Change', exact: true }).click(); await expect(page.getByLabel('Document version').locator('option:checked')).toContainText('Version 2'); expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
  await page.getByRole('button', { name: 'Inspect Version 1 Edit Set', exact: true }).click(); await expect(page.getByLabel('Edit set message')).toHaveValue('Newer unsent draft message'); await expect(page.getByLabel('Complete Word edit set')).toContainText('Reviewed evidence'); await expect(page.getByRole('button', { name: 'Save All 2 Tracked Edits', exact: true })).toBeDisabled(); expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(2);
});

test('Word edit set quota drafts survive navigation and obsolete source rejection without partial saves', async ({ page, request, baseURL }) => {
  const initial = await create(request, baseURL!), id = initial.revision.id, original = initial.versions[0]!; await page.goto(`./#${id}`);
  await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (/docx-(?:draft|request):/.test(key)) throw new DOMException('Test quota', 'QuotaExceededError'); original.call(this, key, value); }; });
  await prepare(page); await page.goto('./#drafts'); await page.goto(`./#${id}`); await page.getByRole('button', { name: 'Inspect Version 1 Edit Set', exact: true }).click(); await expect(page.getByLabel('Complete Word edit set')).toContainText('Reviewed evidence');
  const range = original.docx!.projection.editableRanges.find(range => range.text === 'The original result is clear.')!, state = await api<AppState>(request, baseURL!, '/state');
  await api(request, baseURL!, `/revisions/${id}/docx/replace`, { expectedVersion: original.number, expectedVersionId: original.id, expectedContentHash: original.contentHash, expectedAccessEpoch: state.accessEpoch, rangeId: range.id, start: 4, end: 12, quote: 'original', replacement: 'newer', message: 'Concurrent change' });
  await page.getByRole('button', { name: 'Save All 2 Tracked Edits', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Unconfirmed Word Document Change', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Export Tracked Edit Set', exact: true })).toBeEnabled(); await expect(page.getByLabel('Complete Word edit set')).toContainText('Reviewed evidence'); expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(2);
});
