import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { fromBufferPromise } from 'yauzl';
import { ZipFile } from 'yazl';
import type { FileRecord } from '../shared/files';
import type { AppState, RevisionDetail } from '../shared/types';
import type { DocxResolutionDetail } from '../shared/docx-resolution';
import { normalizeBasePath } from '../shared/mount';

async function source(): Promise<Buffer> {
  const input = await fromBufferPromise(await readFile('tests/fixtures/docx/roundtrip.docx')), zip = new ZipFile(), chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(Buffer.from(chunk))); zip.outputStream.once('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.once('error', reject); });
  try { for await (const entry of input.eachEntry()) {
    const content: Buffer[] = []; for await (const chunk of await input.openReadStreamPromise(entry)) content.push(Buffer.from(chunk)); let data = Buffer.concat(content);
    if (entry.fileName === 'word/document.xml') data = Buffer.from(data.toString().replace('<w:body>', '<w:body><w:p><w:r><w:t xml:space="preserve">The </w:t></w:r><w:del w:id="700" w:author="Imported drafter"><w:r><w:rPr><w:b/></w:rPr><w:delText>earlier</w:delText></w:r></w:del><w:ins w:id="701" w:author="Imported drafter"><w:r><w:rPr><w:i/></w:rPr><w:t>revised</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> argument.</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Evidence: </w:t></w:r><w:ins w:id="702"><w:r><w:t>supported finding</w:t></w:r></w:ins></w:p><w:p><w:ins w:id="703"><w:r><w:t>Preserved complex change</w:t></w:r></w:ins><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>DATE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'));
    zip.addBuffer(data, entry.fileName);
  } } finally { input.close(); }
  zip.end(); return done;
}
async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> {
  const url = new URL(`api${path}`, baseURL).href, response = body === undefined ? await request.get(url) : await request.post(url, { data: body, headers: { 'Idempotency-Key': randomUUID() } }); expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>;
}
async function create(request: APIRequestContext, baseURL: string) {
  const bytes = await source(), file = await api<FileRecord>(request, baseURL, '/files', { name: 'tracked-decisions.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }), state = await api<AppState>(request, baseURL, '/state');
  const initial = await api<RevisionDetail>(request, baseURL, '/revisions/docx', { title: 'Word tracked change decisions', testPlan: 'Review complete text and one immutable package.', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, expectedAccessEpoch: state.accessEpoch, shareSource: false });
  const inspection = await api<DocxResolutionDetail>(request, baseURL, `/revisions/${initial.revision.id}/docx/${initial.versions[0]!.id}/changes`);
  return { initial, inspection };
}
async function prepare(page: Page, id: string) {
  await page.goto(`./#${id}`); await page.getByRole('button', { name: 'Accept or Reject Word Changes', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect Supported Word Changes', exact: true }).click();
  await expect(page.getByLabel('Complete supported Word changes')).toBeVisible();
}

test('Word decisions preview complete mixed choices, preserve complex changes and allow the next editing round', async ({ page, request, baseURL }, info) => {
  const { initial, inspection } = await create(request, baseURL!), id = initial.revision.id, count = inspection.inspection.changes.length; await prepare(page, id);
  await page.getByRole('button', { name: 'Accept All Supported Changes', exact: true }).click();
  for (const text of ['earlier', 'revised']) {
    const index = inspection.inspection.changes.findIndex(change => change.text === text); expect(index).toBeGreaterThanOrEqual(0);
    await page.getByRole('combobox', { name: `Decision for change ${index + 1}`, exact: true }).selectOption('reject');
  }
  const preview = page.getByLabel('Complete Word decision preview'); await expect(preview).toContainText('The revised argument.'); await expect(preview).toContainText('The earlier argument.'); await expect(preview).toContainText('Evidence: supported finding');
  await expect(page.getByLabel('Complete supported Word changes')).not.toContainText('Preserved complex change'); await expect(page.getByLabel('Resolve Word tracked changes')).toContainText(`${inspection.inspection.unsupportedChanges.length} unsupported changes preserved`);
  await page.getByLabel('Word decision message').fill('Keep the earlier argument and accept supporting evidence');
  expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await preview.scrollIntoViewIfNeeded(); const directory = `.data/docx-resolution-visual/${normalizeBasePath(process.env.APP_BASE_PATH) === '/' ? 'root' : 'mounted'}`; await mkdir(directory, { recursive: true }); await page.screenshot({ path: `${directory}/${info.project.name}.png` });
  await page.getByRole('button', { name: `Save ${count} Word Decisions`, exact: true }).click(); await expect(page.getByLabel('Document version').locator('option:checked')).toContainText('Version 2');
  const saved = await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`), version = saved.versions[1]!; expect(saved.versions).toHaveLength(2); expect(saved.versions[0]).toEqual(initial.versions[0]); expect(version.docxOperation?.kind).toBe('resolve');
  expect(version.docx!.projection.blocks[0]!.text).toBe('The earlier argument.'); expect(version.docx!.projection.changes.some(change => change.text === 'Preserved complex change')).toBe(true); expect(version.docx!.projection.changes).toHaveLength(inspection.inspection.unsupportedChanges.length);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download Word Version 2', exact: true }).click(); const stream = await (await download).createReadStream(), chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk)); expect(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')).toBe(version.docx!.sha256);
  await page.getByRole('button', { name: 'Edit Multiple Passages', exact: true }).click(); const paragraph = page.getByLabel('Paragraph for next edit'), value = await paragraph.locator('option').filter({ hasText: 'The earlier argument.' }).getAttribute('value'); await paragraph.selectOption(value!);
  await page.getByLabel('Next replacement text').fill('The next carefully reviewed argument.'); await page.getByRole('button', { name: 'Add Passage to Edit Set', exact: true }).click(); await page.getByLabel('Edit set message').fill('Begin the next review round'); await page.getByRole('button', { name: 'Save All 1 Tracked Edits', exact: true }).click(); await expect(page.getByLabel('Document version').locator('option:checked')).toContainText('Version 3');
  expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(3);
});

test('Word decision retries preserve the exact request and a newer draft without reconnect submission', async ({ page, context, request, baseURL }) => {
  const { initial, inspection } = await create(request, baseURL!), id = initial.revision.id, count = inspection.inspection.changes.length, sent: { key?: string; body: unknown }[] = []; let lose = true;
  await context.route(`**/api/revisions/${id}/docx/resolve`, async route => { sent.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() }); const result = await route.fetch(); if (lose) { lose = false; return route.abort('failed'); } return route.fulfill({ response: result }); });
  await prepare(page, id); await page.getByRole('button', { name: 'Reject All Supported Changes', exact: true }).click(); await page.getByLabel('Word decision message').fill('Reject the proposed changes');
  await page.getByRole('button', { name: `Save ${count} Word Decisions`, exact: true }).click(); await expect(page.getByRole('heading', { name: 'Unconfirmed Word Document Change', exact: true })).toBeVisible();
  await page.getByLabel('Word decision message').fill('Newer unsent decision explanation'); await context.setOffline(true); await expect(page.getByLabel('Complete Word decision preview')).toContainText('The earlier argument.'); await expect(page.getByRole('button', { name: 'Export Word Decisions', exact: true })).toBeEnabled(); await context.setOffline(false);
  await expect(page.getByRole('button', { name: 'Retry Exact Word Change', exact: true })).toBeEnabled(); expect(sent).toHaveLength(1); await page.getByRole('button', { name: 'Retry Exact Word Change', exact: true }).click(); await expect(page.getByLabel('Document version').locator('option:checked')).toContainText('Version 2'); expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
  await page.getByRole('button', { name: 'Inspect Version 1 Word Decisions', exact: true }).click(); await expect(page.getByLabel('Word decision message')).toHaveValue('Newer unsent decision explanation'); await expect(page.getByLabel('Complete Word decision preview')).toContainText('The earlier argument.'); await expect(page.getByRole('button', { name: `Save ${count} Word Decisions`, exact: true })).toBeDisabled(); expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(2);
});

test('Word decisions retain their original source after a concurrent version wins', async ({ page, request, baseURL }) => {
  const { initial, inspection } = await create(request, baseURL!), id = initial.revision.id, original = initial.versions[0]!, count = inspection.inspection.changes.length; await prepare(page, id);
  await page.getByRole('button', { name: 'Reject All Supported Changes', exact: true }).click(); await page.getByLabel('Word decision message').fill('Retain this original decision set');
  const state = await api<AppState>(request, baseURL!, '/state'); await api(request, baseURL!, `/revisions/${id}/docx/resolve`, { expectedVersion: original.number, expectedVersionId: original.id, expectedContentHash: original.contentHash, expectedAccessEpoch: state.accessEpoch, decisions: inspection.inspection.changes.map(change => ({ changeId: change.changeId, action: 'accept' })), message: 'Concurrent acceptance' });
  await page.getByRole('button', { name: `Save ${count} Word Decisions`, exact: true }).click(); await expect(page.getByRole('heading', { name: 'Unconfirmed Word Document Change', exact: true })).toBeVisible(); await expect(page.getByLabel('Complete Word decision preview')).toContainText('The earlier argument.'); await expect(page.getByRole('button', { name: 'Export Word Decisions', exact: true })).toBeEnabled(); expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`)).versions).toHaveLength(2);
});
