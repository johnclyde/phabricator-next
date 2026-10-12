import { test, expect, type APIRequestContext, type Page, type Request } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fromBufferPromise } from 'yauzl';
import { ZipFile } from 'yazl';
import type { AppState, RevisionDetail, RevisionVersion } from '../shared/types';
import type { FileDetail, FileRecord } from '../shared/files';
import { normalizeBasePath } from '../shared/mount';
import { notificationInput } from '../shared/notifications';
import { authAccounts } from './auth-fixture';
import { openComparisonOptions } from './comparison-ui';

type Call = <T>(path: string, body?: unknown) => Promise<T>;
interface FixtureApi { call: Call; package: (id: string, version: RevisionVersion) => Promise<Buffer> }
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function localApi(request: APIRequestContext, baseURL: string): FixtureApi {
  const call: Call = async <T,>(path: string, body?: unknown) => {
    const url = new URL(`api${path}`, baseURL).href;
    const response = body === undefined ? await request.get(url) : await request.post(url, { data: body, headers: { 'Idempotency-Key': randomUUID() } });
    expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>;
  };
  return { call, package: async (id, version) => {
    const response = await request.get(new URL(`api/revisions/${id}/docx/${encodeURIComponent(version.id)}/download`, baseURL).href);
    expect(response.ok(), await response.text()).toBe(true);
    const bytes = await response.body(); expect(digest(bytes)).toBe(version.docx!.sha256); return bytes;
  } };
}

function authenticatedApi(page: Page): FixtureApi {
  const basePath = normalizeBasePath(process.env.APP_BASE_PATH);
  const call: Call = async <T,>(path: string, body?: unknown) => page.evaluate(async ({ path, body, basePath }) => {
    const session = await (await fetch(`${basePath}api/session`)).json();
    const response = await fetch(`${basePath}api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, body, basePath }) as Promise<T>;
  return { call, package: async (id, version) => {
    const array = await page.evaluate(async ({ id, versionId, basePath }) => {
      const session = await (await fetch(`${basePath}api/session`)).json();
      const response = await fetch(`${basePath}api/revisions/${id}/docx/${encodeURIComponent(versionId)}/download`, { headers: { 'X-Session-Context': session.sessionContext } });
      if (!response.ok) throw new Error(await response.text()); return Array.from(new Uint8Array(await response.arrayBuffer()));
    }, { id, versionId: version.id, basePath });
    const bytes = Buffer.from(array); expect(digest(bytes)).toBe(version.docx!.sha256); return bytes;
  } };
}

async function rewritePackage(bytes: Buffer, transform: (parts: Map<string, Buffer>) => void): Promise<Buffer> {
  const source = await fromBufferPromise(bytes), parts = new Map<string, Buffer>();
  for await (const entry of source.eachEntry()) {
    const chunks: Buffer[] = [];
    for await (const chunk of await source.openReadStreamPromise(entry)) chunks.push(Buffer.from(chunk));
    parts.set(entry.fileName, Buffer.concat(chunks));
  }
  transform(parts);
  const output = new ZipFile(), chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    output.outputStream.on('data', chunk => chunks.push(Buffer.from(chunk)));
    output.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
    output.outputStream.once('error', reject);
  });
  for (const [name, content] of parts) output.addBuffer(content, name);
  output.end(); return result;
}

async function originalPackage(): Promise<Buffer> {
  return rewritePackage(await readFile('tests/fixtures/docx/roundtrip.docx'), parts => {
    const document = parts.get('word/document.xml')!.toString();
    expect(document).toContain('<w:sectPr');
    parts.set('word/document.xml', Buffer.from(document.replace('<w:sectPr', '<w:p><w:r><w:t>An endnote supports this claim. </w:t></w:r><w:r><w:endnoteReference w:id="3"/></w:r></w:p><w:sectPr')));
    parts.set('word/endnotes.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:endnotes xmlns:w="${wordNamespace}"><w:endnote w:id="3"><w:p><w:r><w:endnoteRef/></w:r><w:r><w:t>Original endnote evidence.</w:t></w:r></w:p></w:endnote></w:endnotes>`));
    parts.set('word/_rels/document.xml.rels', Buffer.from(parts.get('word/_rels/document.xml.rels')!.toString().replace('</Relationships>', '<Relationship Id="rIdComparisonEndnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/></Relationships>')));
    parts.set('[Content_Types].xml', Buffer.from(parts.get('[Content_Types].xml')!.toString().replace('</Types>', '<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/></Types>')));
  });
}

async function upload(api: FixtureApi, bytes: Buffer): Promise<FileRecord> {
  return api.call('/files', { name: 'redline-evidence.docx', dataBase64: bytes.toString('base64'), bytes: bytes.length, sha256: digest(bytes) });
}
async function reimport(api: FixtureApi, detail: RevisionDetail, bytes: Buffer, shareSource = false): Promise<RevisionDetail> {
  const file = await upload(api, bytes), state = await api.call<AppState>('/state'), base = detail.versions.at(-1)!;
  return api.call(`/revisions/${detail.revision.id}/docx/import`, { sourceFile: { fileId: file.id, bytes: file.bytes, sha256: file.sha256 }, shareSource, expectedVersion: base.number, expectedVersionId: base.id, expectedContentHash: base.contentHash, expectedAccessEpoch: state.accessEpoch, message: 'Reimport reviewed exact Word package' });
}
async function replaceOriginal(api: FixtureApi, detail: RevisionDetail, replacement = 'revised'): Promise<RevisionDetail> {
  const base = detail.versions.at(-1)!, state = await api.call<AppState>('/state');
  const range = base.docx!.projection.editableRanges.find(item => item.text === 'The original result is clear.')!;
  expect(range).toBeTruthy();
  return api.call(`/revisions/${detail.revision.id}/docx/replace`, { expectedVersion: base.number, expectedVersionId: base.id, expectedContentHash: base.contentHash, expectedAccessEpoch: state.accessEpoch, rangeId: range.id, start: 4, end: 12, quote: 'original', replacement, message: 'Track a precise text replacement' });
}
async function fixture(api: FixtureApi, shareSource = false) {
  const originalBytes = await originalPackage(), original = await upload(api, originalBytes), state = await api.call<AppState>('/state');
  const initial = await api.call<RevisionDetail>('/revisions/docx', { title: 'Immutable Word redline evidence', testPlan: 'Compare exact Word versions, scope and package identities.', sourceFile: { fileId: original.id, sha256: original.sha256, bytes: original.bytes }, shareSource, expectedAccessEpoch: state.accessEpoch });
  const edited = await replaceOriginal(api, initial), editedBytes = await api.package(initial.revision.id, edited.versions.at(-1)!);
  const noteBytes = await rewritePackage(editedBytes, parts => {
    parts.set('word/document.xml', Buffer.from(parts.get('word/document.xml')!.toString().replace('Unchanged tail and typography.', 'Updated tail and typography.')));
    parts.set('word/footnotes.xml', Buffer.from(parts.get('word/footnotes.xml')!.toString().replace('Source note with exact wording.', 'Revised footnote with exact wording.')));
    parts.set('word/endnotes.xml', Buffer.from(parts.get('word/endnotes.xml')!.toString().replace('Original endnote evidence.', 'Revised endnote evidence.')));
  });
  const detail = await reimport(api, edited, noteBytes, shareSource);
  return { api, detail, id: detail.revision.id, original, originalBytes, editedBytes, noteBytes, v1: detail.versions[0]!, v2: detail.versions[1]!, v3: detail.versions[2]! };
}

async function signIn(page: Page, index = 0) {
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(authAccounts[index]!.username);
  await page.getByLabel('Password', { exact: true }).fill(authAccounts[index]!.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[index]!.displayName);
}
async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign Out', exact: true }).click();
  await page.getByRole('button', { name: /sign out and clear drafts/i }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible();
}
async function command(page: Page, text: string) {
  await page.getByLabel('Workspace command', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
}
async function bodyKey(page: Page, key: string) {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.getSelection()?.removeAllRanges(); });
  await page.keyboard.press(key);
}
function onlyReadMarks(writes: Request[], id: string) {
  for (const write of writes) {
    expect(write.url()).toMatch(/\/api\/notifications\/read$/);
    expect(write.method()).toBe('POST');
    expect(notificationInput(write.postDataJSON())).toMatchObject({ action: 'read_object', objectId: id });
  }
}

async function mockLocalSpeech(page: Page) {
  await page.addInitScript(() => {
    const recorded = { active: '', cancels: 0, texts: [] as string[], utterances: [] as { onend?: () => void }[] };
    Object.assign(window, { wordComparisonSpeech: recorded, SpeechSynthesisUtterance: class { text: string; constructor(text: string) { this.text = text; } } });
    Object.defineProperty(window, 'speechSynthesis', { value: { speaking: false, getVoices: () => [{ localService: true, lang: 'en-US', name: 'Local test voice' }], addEventListener() {}, removeEventListener() {}, cancel() { recorded.active = ''; recorded.cancels++; }, speak(utterance: { text: string; onend?: () => void }) { recorded.active = utterance.text; recorded.texts.push(utterance.text); recorded.utterances.push(utterance); } } });
  });
}
const activeSpeech = (page: Page) => page.evaluate(() => (window as unknown as { wordComparisonSpeech: { active: string } }).wordComparisonSpeech.active);

const panel = (page: Page) => page.getByRole('region', { name: 'Word text comparison', exact: true });
async function openComparison(page: Page) {
  await page.getByRole('button', { name: 'Compare Word Versions', exact: true }).click();
  await expect(panel(page)).toBeVisible();
}
async function choosePair(page: Page, base: number, target: number) {
  for (const [label, number] of [['Base Word version', base], ['Word version to compare', target]] as const) {
    const control = page.getByLabel(label, { exact: true });
    const value = await control.locator('option').filter({ hasText: new RegExp(`^[Vv]ersion ${number}(?:\\D|$)`) }).getAttribute('value');
    expect(value).toBeTruthy(); await control.selectOption(value!);
  }
}
async function expectPair(page: Page, base: number, target: number) {
  await expect(page.getByLabel('Base Word version', { exact: true }).locator('option:checked')).toContainText(new RegExp(`[Vv]ersion ${base}(?:\\D|$)`));
  await expect(page.getByLabel('Word version to compare', { exact: true }).locator('option:checked')).toContainText(new RegExp(`[Vv]ersion ${target}(?:\\D|$)`));
}
async function changedText(page: Page) {
  return { removed: (await panel(page).locator('del').allTextContents()).join(''), added: (await panel(page).locator('ins').allTextContents()).join('') };
}
async function comparedText(page: Page) {
  return panel(page).locator('.literal-diff').evaluate(element => {
    const segments = Array.from(element.children);
    return {
      before: segments.filter(segment => segment.tagName !== 'INS').map(segment => segment.textContent ?? '').join(''),
      after: segments.filter(segment => segment.tagName !== 'DEL').map(segment => segment.textContent ?? '').join(''),
    };
  });
}

test('Word redlines compare real exact versions forward, reverse and equal without changing package discussion', async ({ page, request, baseURL }) => {
  const data = await fixture(localApi(request, baseURL!));
  const changedMetadata = await rewritePackage(data.noteBytes, parts => {
    parts.set('word/comments.xml', Buffer.from(parts.get('word/comments.xml')!.toString().replace('Please preserve this comment.', 'Only the imported comment changed.')));
  });
  const four = await reimport(data.api, data.detail, changedMetadata);
  expect(four.versions[3]!.docx!.sha256).not.toBe(data.v3.docx!.sha256);
  const writes: Request[] = []; page.on('request', row => { if (row.method() !== 'GET') writes.push(row); });
  await page.goto(`./#${data.id}`); await openComparison(page); await choosePair(page, 1, 2);
  await expect.poll(() => changedText(page)).toEqual({ removed: 'original', added: 'revised' });
  await expect(panel(page)).not.toContainText('old wording');
  await expect(panel(page)).toContainText('new wording');
  await expect(page.getByLabel('Document version').locator('option:checked')).toContainText('Version 4');
  await expect(page.getByRole('heading', { name: 'Workspace Discussion · Version 4', exact: true })).toBeVisible();
  await openComparisonOptions(page, true);
  await page.getByRole('button', { name: 'Swap Word versions', exact: true }).click(); await expectPair(page, 2, 1);
  await expect.poll(() => changedText(page)).toEqual({ removed: 'revised', added: 'original' });
  await choosePair(page, 2, 2); await expect.poll(() => changedText(page)).toEqual({ removed: '', added: '' });
  await expect(panel(page)).toContainText(/no .*text changes|unchanged.*text/i);
  await choosePair(page, 3, 4); await expect.poll(() => changedText(page)).toEqual({ removed: '', added: '' });
  await expect(panel(page)).toContainText(/packages differ|different.*package|package.*differ/i);
  await expect(panel(page)).toContainText(/projection|projected/i);
  await expect(panel(page).getByRole('button', { name: /^Comment on line/ })).toHaveCount(0);
  await choosePair(page, 2, 1); await openComparisonOptions(page, true); await page.getByRole('button', { name: 'Read compared Word version', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByLabel('Document version')).toHaveValue(data.v1.id);
  await expect(page.getByLabel('Word document text')).toContainText('The original result is clear.');
  await expect(page.getByLabel('Word document text').locator('del')).toHaveText('old wording');
  await expect(page.getByLabel('Word document text').locator('ins')).toHaveText('new wording');
  await expect(page.getByRole('heading', { name: 'Workspace Discussion · Version 1', exact: true })).toBeVisible();
  const after = await data.api.call<RevisionDetail>(`/revisions/${data.id}`);
  expect(after.versions).toEqual(four.versions); expect(after.comments).toEqual(four.comments); expect(after.reviews).toEqual(four.reviews);
  expect(after.versions.every(version => version.files.length === 0)).toBe(true);
  onlyReadMarks(writes, data.id);
});

test('Word redlines put readable changes before advanced options without changing exact selection', async ({ page, request, baseURL }, info) => {
  const data = await fixture(localApi(request, baseURL!));
  const writes: Request[] = []; page.on('request', row => { if (row.method() !== 'GET') writes.push(row); });
  await page.goto(`./#${data.id}`); await openComparison(page);
  await expect(panel(page).getByRole('heading', { name: 'Compare Word Versions', exact: true })).toBeFocused();
  await choosePair(page, 1, 3);
  const comparison = panel(page), options = comparison.locator('.docx-comparison-options'), summary = options.locator(':scope > summary');
  const redline = comparison.getByLabel('Selected Word scope comparison', { exact: true }), navigation = comparison.locator('.passage-navigation');
  await expect(options).toHaveJSProperty('open', false);
  await expect(comparison.getByRole('button', { name: 'Read compared Word version', exact: true })).toBeHidden();
  await expect(redline).toBeVisible();
  await expect.poll(() => changedText(page)).toEqual({ removed: 'originalUnchanged', added: 'revisedUpdated' });
  await expect(navigation).toContainText('Change 1 of 2');
  const limitation = comparison.locator('.docx-comparison-limitation');
  await expect(limitation).toBeVisible();
  await expect(limitation).toContainText('formatting and some tracked changes are omitted');
  await expect(limitation).toContainText('Word files differ, even if their displayed text matches.');
  await expectPair(page, 1, 3);
  for (const control of [
    page.getByLabel('Base Word version', { exact: true }), page.getByLabel('Word version to compare', { exact: true }),
    page.getByLabel('Word comparison scope', { exact: true }), page.getByLabel('Word comparison mode', { exact: true }),
    comparison.getByRole('button', { name: 'Close Word comparison', exact: true }),
    comparison.getByRole('button', { name: 'Next change', exact: true }), summary,
  ]) {
    await expect(control).toBeVisible(); const box = await control.boundingBox();
    expect(box).not.toBeNull(); if (info.project.name === 'mobile') expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  const top = (await comparison.boundingBox())!.y, textTop = (await redline.boundingBox())!.y;
  if (info.project.name === 'mobile') expect(textTop - top).toBeLessThanOrEqual(550);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await comparison.evaluate(element => element.scrollIntoView({ block: 'start' }));
  await expect(redline).toBeInViewport();
  await page.screenshot({ path: info.outputPath('word-reading-first-viewport.png') });

  const savedSelection = () => page.evaluate(id => {
    const key = Object.keys(localStorage).find(key => key.endsWith(`:docx-comparison:${id}`));
    return key ? localStorage.getItem(key) : null;
  }, data.id);
  const before = await savedSelection(); expect(before).toBeTruthy();
  await summary.focus(); await summary.press('j');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(summary).toBeFocused(); await expect(navigation).toContainText('Change 1 of 2');
  await expect(options).toHaveJSProperty('open', false);
  await summary.press('Enter'); await expect(options).toHaveJSProperty('open', true);
  await expectPair(page, 1, 3); expect(await savedSelection()).toBe(before);
  await expect(page.getByLabel('Word comparison scope', { exact: true })).toHaveValue('document');
  await expect(page.getByLabel('Word comparison mode', { exact: true })).toHaveValue('words');
  await expect(comparison.getByRole('button', { name: 'Read compared Word version', exact: true })).toBeVisible();
  await expect(comparison.getByLabel('Skip space/tab-only changes', { exact: true })).toBeVisible();
  await expect.poll(() => changedText(page)).toEqual({ removed: 'originalUnchanged', added: 'revisedUpdated' });
  const after = await data.api.call<RevisionDetail>(`/revisions/${data.id}`);
  expect(after.versions).toEqual(data.detail.versions); expect(after.comments).toEqual(data.detail.comments); expect(after.reviews).toEqual(data.detail.reviews);
  onlyReadMarks(writes, data.id);
});

test('Word comparison scopes retain exact main, footnote and endnote distinctions without projected-line authoring', async ({ page, request, baseURL }, info) => {
  const data = await fixture(localApi(request, baseURL!));
  const writes: Request[] = []; page.on('request', row => { if (row.method() !== 'GET') writes.push(row); });
  await page.goto(`./#${data.id}`); await openComparison(page); await choosePair(page, 1, 3);
  const scope = page.getByLabel('Word comparison scope', { exact: true });
  await expect(scope).toHaveValue('document');
  await expect(panel(page)).toContainText('[Note reference: footnote:2]');
  await expect(panel(page)).toContainText('[Note reference: endnote:3]');
  await expect(panel(page)).not.toContainText('Original endnote evidence.');
  await scope.selectOption('footnotes');
  await expect(panel(page)).toContainText('[Footnote ID: footnote:2]');
  await expect.poll(async () => (await comparedText(page)).before).toContain('Source note with exact wording.');
  await expect.poll(async () => (await comparedText(page)).after).toContain('Revised footnote with exact wording.');
  await expect(panel(page)).not.toContainText('The original result is clear.');
  await scope.selectOption('endnotes');
  await expect(panel(page)).toContainText('[Endnote ID: endnote:3]');
  await expect.poll(() => changedText(page)).toEqual({ removed: 'Original', added: 'Revised' });
  await page.getByLabel('Word comparison mode', { exact: true }).selectOption('lines');
  await expect(panel(page).getByRole('button', { name: /^Comment on line/ })).toHaveCount(0);
  await expect(panel(page).locator('.line-number button')).toHaveCount(0);
  await expect(panel(page).getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Workspace Discussion · Version 3', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (info.project.name === 'mobile') expect((await page.getByRole('button', { name: 'Close Word comparison', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await panel(page).screenshot({ path: info.outputPath('word-scope-redline.png') });
  await page.getByRole('button', { name: 'Close Word comparison', exact: true }).click();
  await expect(page.getByLabel('Word document text')).toContainText('Updated tail and typography.');
  onlyReadMarks(writes, data.id);
});

test('Word keyboard, touch and local narration share the fixed pair and cancel on scope or reader changes', async ({ page, request, baseURL }) => {
  await mockLocalSpeech(page);
  const data = await fixture(localApi(request, baseURL!));
  await page.goto(`./#${data.id}`); await openComparison(page); await choosePair(page, 1, 3);
  const navigation = panel(page).locator('.passage-navigation');
  await expect(navigation).toContainText('Change 1 of 2');
  await bodyKey(page, 'j'); await expect(navigation).toContainText('Change 2 of 2');
  await bodyKey(page, 'j'); await expect(navigation).toContainText('Change 2 of 2');
  await page.getByRole('button', { name: 'Previous change', exact: true }).click(); await expect(navigation).toContainText('Change 1 of 2');
  await bodyKey(page, 'Shift+J'); await expect(page.getByLabel('Word comparison scope', { exact: true })).toHaveValue('footnotes');
  await bodyKey(page, 'Shift+K'); await expect(page.getByLabel('Word comparison scope', { exact: true })).toHaveValue('document');
  await page.getByLabel('Review comment', { exact: true }).fill('j'); await page.getByLabel('Review comment', { exact: true }).press('j');
  await expect(navigation).toContainText('Change 1 of 2');
  await page.getByLabel('Review comment', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  await page.getByLabel('Speak responses (on-device only)', { exact: true }).check();
  await command(page, 'read changes');
  await expect(page.locator('.command-feedback')).toContainText('version 1 to version 3');
  expect(await activeSpeech(page)).toContain('original');
  expect(await activeSpeech(page)).not.toContain('old wording');
  await command(page, 'next change'); await expect(navigation).toContainText('Change 2 of 2');
  await expect(page.locator('.command-feedback')).toContainText('Change 2 of 2');
  await page.getByLabel('Word comparison scope', { exact: true }).selectOption('footnotes');
  await expect.poll(() => activeSpeech(page)).toBe('');
  await page.evaluate(() => (window as unknown as { wordComparisonSpeech: { utterances: { onend?: () => void }[] } }).wordComparisonSpeech.utterances.forEach(item => item.onend?.()));
  expect(await activeSpeech(page)).toBe('');
  await command(page, 'read current change'); expect(await activeSpeech(page)).toContain('Footnotes');
  await command(page, 'next file'); await expect(page.getByLabel('Word comparison scope', { exact: true })).toHaveValue('endnotes');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect((await activeSpeech(page)).toLowerCase()).toContain('endnote');
  await command(page, 'previous file'); await expect(page.getByLabel('Word comparison scope', { exact: true })).toHaveValue('footnotes');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect((await activeSpeech(page)).toLowerCase()).toContain('footnote');
  await page.getByLabel('Document version', { exact: true }).selectOption(data.v1.id);
  await expect(panel(page)).toHaveCount(0); await expect.poll(() => activeSpeech(page)).toBe('');
  await expect(page.getByLabel('Word document text')).toContainText('The original result is clear.');
});

test('local Word pairs survive a new head and offline reopening while invalid stored pins remain unavailable', async ({ page, request, baseURL, context }) => {
  const data = await fixture(localApi(request, baseURL!));
  await page.goto(`./#${data.id}`);
  // Explicitly pin a reader version so recovery must use that historical reader,
  // even after a new head appears and the authority refresh remounts the reader.
  await page.getByLabel('Document version', { exact: true }).selectOption(data.v2.id);
  await page.getByLabel('Document version', { exact: true }).selectOption(data.v3.id);
  await openComparison(page); await choosePair(page, 1, 2);
  await page.getByLabel('Word comparison scope', { exact: true }).selectOption('endnotes');
  await page.getByLabel('Word comparison mode', { exact: true }).selectOption('lines');
  await reimport(data.api, data.detail, data.noteBytes);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Document version').locator('option')).toHaveCount(4);
  await expect(page.getByLabel('Document version', { exact: true })).toHaveValue(data.v3.id);
  // The new File advances authority. Reopen after verified detail refresh;
  // the reader may retire, but the explicitly selected immutable pair must not move.
  await expect(panel(page)).toHaveCount(0); await openComparison(page);
  await expectPair(page, 1, 2);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  try {
    await page.reload(); await openComparison(page); await expectPair(page, 1, 2);
    await expect(page.getByLabel('Document version', { exact: true })).toHaveValue(data.v3.id);
    await expect(page.getByLabel('Word comparison scope', { exact: true })).toHaveValue('endnotes');
    await expect(page.getByLabel('Word comparison mode', { exact: true })).toHaveValue('lines');
    await expect(panel(page)).toContainText('Original endnote evidence.');
    await expect.poll(() => changedText(page)).toEqual({ removed: '', added: '' });
  } finally { await context.setOffline(false); }
  await page.evaluate(id => {
    const key = Object.keys(localStorage).find(key => key.endsWith(`:docx-comparison:${id}`));
    if (!key) throw new Error('Expected saved Word comparison metadata.');
    const saved = JSON.parse(localStorage.getItem(key)!); saved.target.contentHash = '0'.repeat(64); localStorage.setItem(key, JSON.stringify(saved));
  }, data.id);
  await page.reload(); await openComparison(page);
  await expect(panel(page)).toContainText(/unavailable|does not match|mismatch/i);
  await expect(panel(page).locator('ins, del')).toHaveCount(0);
  await openComparisonOptions(page, true); await page.getByRole('button', { name: 'Compare selected reader version', exact: true }).click();
  await expectPair(page, 2, 3);
});

test('a late tracked-save detail response cannot close a subsequently selected historical Word comparison', async ({ page, request, baseURL }) => {
  const data = await fixture(localApi(request, baseURL!));
  await page.goto(`./#${data.id}`);
  await page.getByRole('button', { name: 'Open Tracked Editor', exact: true }).click();
  const editable = page.getByLabel('Editable text', { exact: true });
  const range = await editable.locator('option').filter({ hasText: 'Findings and evidence' }).getAttribute('value');
  expect(range).toBeTruthy(); await editable.selectOption(range!);
  await page.getByLabel('Replacement text', { exact: true }).fill('Reviewed findings and evidence');
  await page.getByLabel('Edit message', { exact: true }).fill('A save whose detail response arrives late');
  let release!: () => void, reached!: () => void, waiting = false;
  const held = new Promise<void>(resolve => { release = resolve; }), captured = new Promise<void>(resolve => { reached = resolve; });
  await page.route(`**/api/revisions/${data.id}`, async route => {
    const response = await route.fetch(), detail = await response.json() as RevisionDetail;
    if (detail.versions.length === 4 && !waiting) { waiting = true; reached(); await held; }
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: 'Save Tracked Edit', exact: true }).click(); await captured;
    await openComparison(page); await choosePair(page, 1, 2);
    const refreshed = page.waitForResponse(response => response.url() === new URL('api/state', baseURL!).href && response.ok());
    release(); await refreshed; await page.unrouteAll({ behavior: 'wait' });
    await expect(page.getByLabel('Document version').locator('option')).toHaveCount(4);
    await expect(page.getByLabel('Document version')).toHaveValue(data.v3.id);
    await expectPair(page, 1, 2);
    await expect.poll(() => changedText(page)).toEqual({ removed: 'original', added: 'revised' });
    expect((await data.api.call<RevisionDetail>(`/revisions/${data.id}`)).versions).toHaveLength(4);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('historical Word source revocation retires comparison and old speech despite a still-shared newer source', async ({ browser }, info) => {
  const basePath = normalizeBasePath(process.env.APP_BASE_PATH), baseURL = `http://127.0.0.1:4312${basePath}`;
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ baseURL, serviceWorkers: 'block', viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch })));
  try {
    const [alice, bob] = await Promise.all(contexts.map(context => context.newPage()));
    await mockLocalSpeech(bob!);
    for (const [index, page] of [alice!, bob!].entries()) { await page.goto('./#home'); await signIn(page, index); }
    const data = await fixture(authenticatedApi(alice!), true);
    await bob!.goto(`./#${data.id}`); await openComparison(bob!); await choosePair(bob!, 1, 3);
    await bob!.getByRole('button', { name: 'Voice and commands', exact: true }).click();
    await bob!.getByLabel('Speak responses (on-device only)', { exact: true }).check(); await command(bob!, 'read changes');
    expect(await activeSpeech(bob!)).toContain('original');
    const file = await data.api.call<FileDetail>(`/files/${data.original.id}`), attachment = file.attachments.attachments.find(item => item.objectId === data.id)!;
    await data.api.call(`/files/${data.original.id}/attachments`, { objectId: data.id, mode: 'detach', expectedVersion: attachment.version });
    await bob!.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(bob!.getByRole('heading', { name: 'Object unavailable', exact: true })).toBeVisible();
    await expect(panel(bob!)).toHaveCount(0); await expect(bob!.getByLabel('Word document text')).toHaveCount(0);
    await expect.poll(() => activeSpeech(bob!)).toBe('');
    await bob!.evaluate(() => (window as unknown as { wordComparisonSpeech: { utterances: { onend?: () => void }[] } }).wordComparisonSpeech.utterances.forEach(item => item.onend?.()));
    expect(await activeSpeech(bob!)).toBe('');
    expect(await bob!.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('The original result is clear.');
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('password Word comparisons remain in memory and cannot survive offline lock or an account switch', async ({ browser }, info) => {
  const baseURL = `http://127.0.0.1:4312${normalizeBasePath(process.env.APP_BASE_PATH)}`;
  const context = await browser.newContext({ baseURL, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch });
  try {
    const page = await context.newPage(); await page.goto('./#home'); await signIn(page);
    const data = await fixture(authenticatedApi(page));
    await page.goto(`./#${data.id}`); await openComparison(page); await choosePair(page, 1, 2);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(stored).not.toContain('The original result is clear.'); expect(stored).not.toContain(data.v1.id); expect(stored).not.toContain(data.v2.id);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await context.setOffline(true);
    await page.reload(); await expect(page.getByRole('heading', { name: 'Workspace locked', exact: true })).toBeVisible();
    await expect(panel(page)).toHaveCount(0); await expect(page.getByLabel('Word document text')).toHaveCount(0);
    await context.setOffline(false); await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[0].displayName);
    await page.goto(`./#${data.id}`); await openComparison(page); await choosePair(page, 1, 2);
    const other = await context.newPage(); await other.goto('./#home'); await signOut(other);
    await expect(page.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible();
    await expect(panel(page)).toHaveCount(0); await signIn(other, 1);
    await expect(page.locator('.signed-in-user')).toHaveText(authAccounts[1].displayName);
    await page.goto(`./#${data.id}`); await expect(page.getByRole('heading', { name: 'Object unavailable', exact: true })).toBeVisible();
    await expect(panel(page)).toHaveCount(0); await expect(page.getByLabel('Word document text')).toHaveCount(0);
  } finally { await context.setOffline(false); await context.close(); }
});
