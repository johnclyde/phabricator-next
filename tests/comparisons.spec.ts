import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { RevisionDetail, SourceFile } from '../shared/types';
async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> {
  const url = new URL(`api${path}`, baseURL).href;
  const response = body === undefined ? await request.get(url) : await request.post(url, { data: body });
  expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>;
}
async function create(request: APIRequestContext, baseURL: string, files: SourceFile[]) {
  return api<RevisionDetail>(request, baseURL, '/revisions', { testPlan: 'Fixture verification plan.', kind: 'document', title: `Exact comparison ${Date.now()}`, files });
}
async function add(request: APIRequestContext, baseURL: string, id: string, expectedVersion: number, files: SourceFile[]) { await api(request, baseURL, `/revisions/${id}/versions`, { files, expectedVersion, message: `Version ${expectedVersion + 1}` }); }
async function open(page: Page, id: string) { await page.goto(`./#${id}`); await expect(page.getByLabel('Version to inspect', { exact: true })).toBeVisible(); }
async function command(page: Page, text: string) { await page.getByLabel('Workspace command', { exact: true }).fill(text); await page.getByRole('button', { name: 'Run', exact: true }).click(); }

test('arbitrary comparisons retain exact pair and file across refresh and offline reload, including removed and empty files', async ({ page, request, baseURL, context }, info) => {
  const files1 = [{ path: 'motion.md', content: 'First short claim.\nSecond old claim.\n' }, { path: 'removed.txt', content: 'Keep the removed evidence.\n' }, { path: 'empty.txt', content: '' }];
  const files2 = [{ path: 'motion.md', content: 'First precise claim.\nSecond new claim.\n' }, { path: 'added.txt', content: '' }];
  const detail = await create(request, baseURL!, files1); const id = detail.revision.id;
  await add(request, baseURL!, id, 1, files2); await open(page, id);
  await expect(page.getByLabel('Base version', { exact: true })).toHaveValue('1');
  await page.getByLabel('Source file', { exact: true }).selectOption('removed.txt');
  await expect(page.locator('.prose-content del')).toHaveText('Keep the removed evidence.\n');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByText('This file is absent from the selected target.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Comment on line/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByLabel('Source file', { exact: true }).selectOption('added.txt'); await expect(page.locator('.prose-content')).toHaveText('Empty file added.');
  await page.getByRole('button', { name: 'Swap versions', exact: true }).click();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Base version', { exact: true })).toHaveValue('2');
  await expect(page.locator('.prose-content')).toHaveText('Empty file removed.');
  await page.getByLabel('Source file', { exact: true }).selectOption('motion.md');
  await page.getByLabel('Comparison mode', { exact: true }).selectOption('lines');
  await page.getByRole('button', { name: 'Comment on line 1', exact: true }).click();
  await expect(page.locator('.comment-target')).toContainText('motion.md:1');
  await add(request, baseURL!, id, 2, [{ path: 'latest.txt', content: 'Unrelated latest source' }]);
  await page.reload();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Base version', { exact: true })).toHaveValue('2');
  await expect(page.getByLabel('Source file', { exact: true })).toHaveValue('motion.md');
  await expect(page.getByLabel('Comparison mode', { exact: true })).toHaveValue('lines');
  await expect(page.getByText('The current version is 3.', { exact: false })).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await context.setOffline(true); await page.reload();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('2');
  await expect(page.getByLabel('Base version', { exact: true })).toHaveValue('2');
  await expect(page.locator('.passage-navigation')).toContainText('No text changes');
  await context.setOffline(false);
  await add(request, baseURL!, id, 3, [{ path: 'latest.txt', content: 'Fourth version arrives through workspace refresh' }]);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Version to inspect', { exact: true }).locator('option[value="4"]')).toHaveCount(1);
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
  await expect(page.getByLabel('Base version', { exact: true })).toHaveValue('2');
  await page.getByRole('button', { name: 'Show current version', exact: true }).click();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('4');
  await page.getByLabel('Base version', { exact: true }).selectOption('1');
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('2');
  await page.getByLabel('Comparison mode', { exact: true }).selectOption('words');
  await page.getByRole('button', { name: 'Next change', exact: true }).evaluate(element => element.scrollIntoView({ block: 'center' }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (info.project.name === 'mobile') expect((await page.getByRole('button', { name: 'Next change', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath('exact-comparison.png') });
});

test('typed changes and local speech follow the selected file and passage and stop on selection or navigation changes', async ({ page, request, baseURL }) => {
  await page.addInitScript(() => {
    const recorded = { texts: [] as string[], utterances: [] as { onend?: () => void }[], recognizers: [] as unknown[], cancels: 0, starts: 0 };
    Object.assign(window, { speechTest: recorded, SpeechSynthesisUtterance: class { text: string; constructor(text: string) { this.text = text; } }, SpeechRecognition: class { constructor() { recorded.recognizers.push(this); } start() { recorded.starts++; } abort() {} stop() {} } });
    Object.defineProperty(window, 'speechSynthesis', { value: { speaking: false, getVoices: () => [{ localService: true, lang: 'en-US', name: 'Local test' }], addEventListener() {}, removeEventListener() {}, cancel() { recorded.cancels++; }, speak(utterance: { text: string; onend?: () => void }) { recorded.texts.push(utterance.text); recorded.utterances.push(utterance); } } });
  });
  const detail = await create(request, baseURL!, [{ path: 'motion.md', content: 'One old idea. Stable separator. Two old ideas.' }, { path: 'secret-latest.txt', content: 'Do not narrate another file.' }]);
  await add(request, baseURL!, detail.revision.id, 1, [{ path: 'motion.md', content: 'One new idea. Stable separator. Two better ideas.' }]); await open(page, detail.revision.id);
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  await page.getByLabel('Speak responses (on-device only)', { exact: true }).check();
  await page.getByLabel(/I understand browser speech recognition/).check(); await page.getByRole('button', { name: 'Start Hands-free Listening', exact: true }).click();
  await command(page, 'read changes'); await expect(page.locator('.command-feedback')).toContainText('version 1 to version 2, file motion.md');
  await command(page, 'next change'); await expect(page.locator('.passage-navigation')).toContainText('Change 2 of 2');
  await expect(page.locator('.command-feedback')).toContainText('Change 2 of 2');
  const before = await page.evaluate(() => (window as unknown as { speechTest: { cancels: number; texts: string[] } }).speechTest);
  expect(before.texts.at(-1)).toContain('Change 2 of 2');
  await page.getByLabel('Source file', { exact: true }).selectOption('secret-latest.txt');
  await expect(page.locator('.command-feedback')).toHaveCount(0);
  const starts = await page.evaluate(() => (window as unknown as { speechTest: { starts: number } }).speechTest.starts);
  await page.evaluate(() => (window as unknown as { speechTest: { utterances: { onend?: () => void }[] } }).speechTest.utterances.forEach(utterance => utterance.onend?.()));
  expect(await page.evaluate(() => (window as unknown as { speechTest: { starts: number } }).speechTest.starts)).toBe(starts);
  await command(page, 'read current change'); await expect(page.locator('.command-feedback')).toContainText('File deleted.');
  await command(page, 'stop speaking');
  const stoppedStarts = await page.evaluate(() => (window as unknown as { speechTest: { starts: number } }).speechTest.starts);
  await page.evaluate(() => (window as unknown as { speechTest: { utterances: { onend?: () => void }[] } }).speechTest.utterances.forEach(utterance => utterance.onend?.()));
  expect(await page.evaluate(() => (window as unknown as { speechTest: { starts: number } }).speechTest.starts)).toBe(stoppedStarts);
  await page.getByRole('button', { name: 'Stop Listening', exact: true }).click(); await page.getByRole('button', { name: 'Start Hands-free Listening', exact: true }).click();
  const restarted = await page.evaluate(() => (window as unknown as { speechTest: { starts: number } }).speechTest.starts);
  await page.evaluate(() => { const old = (window as unknown as { speechTest: { recognizers: { onend?: () => void; onresult?: (event: unknown) => void; onerror?: (event: unknown) => void }[] } }).speechTest.recognizers[0]!; old.onend?.(); old.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'open tasks' } }] }); old.onerror?.({ error: 'not-allowed' }); });
  expect(await page.evaluate(() => (window as unknown as { speechTest: { starts: number } }).speechTest.starts)).toBe(restarted);
  await expect(page.getByLabel('Version to inspect', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Stop Listening', exact: true })).toBeVisible();
  await page.goto('./#tasks'); await expect(page.locator('.command-feedback')).toHaveCount(0);
  await command(page, 'read changes'); await expect(page.locator('.command-feedback')).toContainText('Open an available');
});

test('missing or mismatched stored identities are explicit and large comparisons offer exact source downloads', async ({ page, request, baseURL }) => {
  const detail = await create(request, baseURL!, [{ path: 'large.md', content: 'x'.repeat(210000) }]); await open(page, detail.revision.id);
  await expect(page.getByRole('heading', { name: 'Comparison too large to render safely', exact: true })).toBeVisible();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download target source', exact: true }).click(); expect((await download).suggestedFilename()).toBe('v1-large.md');
  await page.evaluate(id => { const key = Object.keys(localStorage).find(key => key.endsWith(`:revision-comparison:${id}`))!; const selection = JSON.parse(localStorage.getItem(key)!); selection.target.contentHash = 'mismatched'; localStorage.setItem(key, JSON.stringify(selection)); }, detail.revision.id);
  await page.reload(); await expect(page.getByText('A selected immutable version is unavailable', { exact: false })).toBeVisible(); await expect(page.locator('.exact-comparison')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show current version', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Comparison too large to render safely' })).toBeVisible();
  await page.getByRole('button', { name: 'Source', exact: true }).click(); await expect(page.getByText('This target source exceeds the inline display limit.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Comment on line/ })).toHaveCount(0);
  await add(request, baseURL!, detail.revision.id, 1, [{ path: 'large.md', content: 'Small authorized target.\n' }]);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Version to inspect', { exact: true }).locator('option[value="2"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Show current version', exact: true }).click(); await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Comparison too large to render safely' })).toBeVisible();
  await expect(page.getByLabel('Source passage text', { exact: true })).toHaveText('Small authorized target.\n');
  await page.getByRole('button', { name: 'Comment on line 1', exact: true }).click(); await expect(page.locator('.comment-target')).toContainText('version 2');
});

test('a delayed saved version cannot erase a newer remounted draft or change its selected comparison', async ({ page, request, baseURL }) => {
  const detail = await create(request, baseURL!, [{ path: 'motion.md', content: 'Original text' }]); await open(page, detail.revision.id);
  let release!: () => void; let received!: () => void;
  const pending = new Promise<void>(resolve => { received = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/revisions/${detail.revision.id}/versions`, async route => { const response = await route.fetch(); received(); await gate; await route.fulfill({ response }); });
  try {
    await page.getByRole('button', { name: 'Edit & add version', exact: true }).click(); await page.getByRole('textbox', { name: 'File content', exact: true }).fill('Submitted text'); await page.getByRole('textbox', { name: 'What changed?', exact: true }).fill('Submitted revision');
    await page.getByRole('button', { name: 'Save New Version', exact: true }).click(); await pending;
    await expect(page.getByRole('textbox', { name: 'File content', exact: true })).toBeDisabled();
    await page.goto('./#drafts'); await expect(page.locator('.version-editor')).toHaveCount(0);
    await page.route(`**/api/revisions/${detail.revision.id}`, async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
    await page.goto(`./#${detail.revision.id}`);
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
    await page.getByRole('button', { name: 'Edit & add version', exact: true }).click();
    await page.getByRole('textbox', { name: 'File content', exact: true }).fill('Newer unsaved text');
    await page.getByRole('textbox', { name: 'What changed?', exact: true }).fill('Newer unsaved message');
    release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
    await expect(page.getByRole('textbox', { name: 'File content', exact: true })).toHaveValue('Newer unsaved text');
    const retained = await page.evaluate(id => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.endsWith(`:version-draft:${id}:1`))!)!), detail.revision.id);
    expect(retained.files[0].content).toBe('Newer unsaved text'); expect(retained.message).toBe('Newer unsaved message');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('late post-save detail refresh cannot replace a comparison chosen while it was pending', async ({ page, request, baseURL }) => {
  const detail = await create(request, baseURL!, [{ path: 'motion.md', content: 'Original' }]);
  await add(request, baseURL!, detail.revision.id, 1, [{ path: 'motion.md', content: 'Second' }]); await open(page, detail.revision.id);
  let release!: () => void; let received!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const pending = new Promise<void>(resolve => { received = resolve; });
  let hold = false;
  await page.route(`**/api/revisions/${detail.revision.id}`, async route => { const response = await route.fetch(); if (hold) { received(); await gate; } await route.fulfill({ response }); });
  try {
    await page.getByRole('button', { name: 'Edit & add version', exact: true }).click();
    await page.getByRole('textbox', { name: 'File content', exact: true }).fill('Third'); await page.getByRole('textbox', { name: 'What changed?', exact: true }).fill('Third version'); hold = true;
    await page.getByRole('button', { name: 'Save New Version', exact: true }).click(); await pending;
    await page.getByLabel('Version to inspect', { exact: true }).selectOption('1');
    release(); await page.unrouteAll({ behavior: 'wait' });
    await expect(page.getByLabel('Version to inspect', { exact: true }).locator('option[value="3"]')).toHaveCount(1);
    await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
    await expect(page.getByLabel('Base version', { exact: true })).toHaveValue('1');
    await expect(page.locator('.passage-navigation')).toContainText('No text changes');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('saving a new version preserves the initiating source view, mode and selected file', async ({ page, request, baseURL }) => {
  const detail = await create(request, baseURL!, [{ path: 'first.md', content: 'First file.' }, { path: 'selected.md', content: 'Keep this selected source.' }]);
  await open(page, detail.revision.id);
  await page.getByLabel('Source file', { exact: true }).selectOption('selected.md');
  await page.getByLabel('Comparison mode', { exact: true }).selectOption('lines');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByRole('button', { name: 'Edit & add version', exact: true }).click();
  await page.getByRole('textbox', { name: 'File content', exact: true }).fill('Revised first file.');
  await page.getByRole('textbox', { name: 'What changed?', exact: true }).fill('Edit without moving the reader.');
  await page.getByRole('button', { name: 'Save New Version', exact: true }).click();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
  await expect(page.getByLabel('Base version', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Source file', { exact: true })).toHaveValue('selected.md');
  await expect(page.getByLabel('Comparison mode', { exact: true })).toHaveValue('lines');
  await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveClass('selected');
  await expect(page.getByLabel('Source passage text', { exact: true })).toHaveText('Keep this selected source.');
});
