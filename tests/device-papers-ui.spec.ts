import { test, expect, chromium, type Locator, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RevisionDetail } from '../shared/types';

const SOURCE = String.raw`\documentclass{article}
\usepackage{amsmath,amssymb}
\title{Finite sums}
\author{A. Researcher}
\date{}
\begin{document}
\maketitle
\section{Proof}
For every $n \in \mathbb{N}$,
\[
\sum_{k=1}^{n} k = \frac{n(n+1)}{2}.
\]
\end{document}
`;
async function expectDocumentPreview(page: Page | Locator) {
  const preview = page.getByRole('region', { name: 'Paper reading preview', exact: true });
  await expect(preview.getByRole('heading', { name: 'Finite sums', exact: true })).toBeVisible();
  await expect(preview.getByText('A. Researcher', { exact: true })).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Proof', exact: true })).toBeVisible();
  await expect(preview.locator('.katex')).toHaveCount(2);
  for (const command of ['documentclass', 'usepackage', 'begin{document}', 'end{document}', 'maketitle']) {
    await expect(preview).not.toContainText(`\\${command}`);
  }
}
async function create(page: Page, title = 'Offline research') {
  await page.getByLabel('Keep papers in this browser profile', { exact: true }).check();
  await page.getByLabel('New paper title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Create device paper', exact: true }).click();
  await expect(page.getByLabel('Paper source', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
}
async function saved(page: Page) { await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible(); }
async function revealOptions(page: Page) {
  const summary = page.locator('summary').filter({ hasText: /^Paper options$/ });
  if (await summary.locator('..').getAttribute('open') === null) await summary.click();
}

test('the paper editor opens around the source with secondary controls tucked away', async ({ page }) => {
  await page.goto('./#device-papers'); await create(page, 'Focused writing');
  const source = page.getByLabel('Paper source', { exact: true });
  const position = await source.boundingBox();
  expect(position).not.toBeNull();
  expect(position!.y).toBeLessThan(page.viewportSize()!.height * 0.65);
  const starterPreview = page.getByRole('region', { name: 'Paper reading preview', exact: true });
  await expect(starterPreview.getByRole('heading', { name: 'Introduction', exact: true })).toBeVisible();
  await expect(starterPreview.locator('.katex')).toHaveCount(2);
  await expect(starterPreview.locator('.paper-math-command')).toHaveCount(0);
  await source.fill(SOURCE); await saved(page);
  await expect(page.getByRole('button', { name: 'Export project', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Delete device paper', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add source file', exact: true })).toBeHidden();
  await expect(page.getByLabel('Source file path', { exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Inline equation', exact: true })).toBeHidden();
  await revealOptions(page);
  await expect(page.getByRole('button', { name: 'Export project', exact: true })).toBeVisible();
  await expect(page.getByLabel('Source file path', { exact: true })).toHaveValue('main.tex');
  await page.locator('summary').filter({ hasText: /^Paper options$/ }).click();
  await page.getByRole('button', { name: 'Preview only', exact: true }).click();
  await expect(source).toHaveCount(0);
  await expectDocumentPreview(page);
  await page.getByRole('button', { name: 'Source only', exact: true }).click();
  await expect(source).toHaveValue(SOURCE);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('first-use math fonts and device papers survive closing and reopening offline without signing in', async ({ page, context, baseURL }, info) => {
  const url = new URL(baseURL!); url.port = '4312'; url.hash = 'device-papers';
  const requests: string[] = [], errors: string[] = [];
  context.on('request', request => { if (new URL(request.url()).pathname.includes('/api/')) requests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url.href);
  await expect(page.getByText('Ready to reopen offline', { exact: false })).toBeVisible({ timeout: 20000 });
  expect(await page.locator('.katex').count()).toBe(0);
  await context.setOffline(true);
  await create(page);
  await page.getByLabel('Paper source', { exact: true }).fill(SOURCE); await saved(page);
  await expect(page.locator('.katex')).toHaveCount(2);
  await revealOptions(page);
  await page.getByRole('button', { name: 'Add source file', exact: true }).click();
  await page.getByLabel('Source file path', { exact: true }).fill('references.bib');
  await page.getByLabel('Paper source', { exact: true }).fill('@book{sample,title={Sample reference},year={2026}}'); await saved(page);
  const paperURL = page.url(); await page.close();
  const reopened = await context.newPage(); reopened.on('pageerror', error => errors.push(error.message));
  await reopened.goto(paperURL);
  await expect(reopened.getByLabel('Paper title', { exact: true })).toHaveValue('Offline research');
  await expect(reopened.getByLabel('Paper source', { exact: true })).toHaveValue(SOURCE);
  await expectDocumentPreview(reopened);
  await reopened.evaluate(() => document.fonts.ready);
  expect(await reopened.evaluate(() => document.fonts.check('16px KaTeX_Main'))).toBe(true);
  await reopened.getByRole('button', { name: 'references.bib', exact: true }).click();
  await expect(reopened.getByLabel('Paper source', { exact: true })).toHaveValue('@book{sample,title={Sample reference},year={2026}}');
  await reopened.getByRole('button', { name: 'main.tex', exact: true }).click();
  const continued = SOURCE.replace(String.raw`\end{document}`, String.raw`An offline continuation.
\end{document}`);
  await reopened.getByLabel('Paper source', { exact: true }).fill(continued); await saved(reopened);
  await reopened.reload(); await expect(reopened.getByLabel('Paper source', { exact: true })).toHaveValue(continued);
  await expect(reopened.getByRole('region', { name: 'Paper reading preview', exact: true })).toContainText('An offline continuation.');
  await expect(reopened.locator('.katex')).toHaveCount(2);
  expect(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await reopened.screenshot({ path: info.outputPath('offline-paper.png'), fullPage: true });
  expect(requests).toEqual([]); expect(errors).toEqual([]);
});

test('competing tabs preserve the winner and offer an independent copy of conflicting edits', async ({ page, context }) => {
  await page.goto('./#device-papers'); await create(page, 'Two tabs');
  const url = page.url(), other = await context.newPage(); await other.goto(url);
  await expect(other.getByLabel('Paper title', { exact: true })).toHaveValue('Two tabs');
  await page.getByLabel('Paper source', { exact: true }).fill('First tab $x$.'); await saved(page);
  await other.getByLabel('Paper source', { exact: true }).fill('Second tab $y$.');
  await expect(other.getByRole('alert')).toContainText('Another tab changed');
  await expect(other.getByLabel('Paper source', { exact: true })).toHaveValue('Second tab $y$.');
  await other.getByRole('button', { name: 'Save edits as new copy', exact: true }).click();
  await expect(other.getByLabel('Paper title', { exact: true })).toHaveValue('Two tabs (copy)'); await saved(other);
  await page.reload(); await expect(page.getByLabel('Paper source', { exact: true })).toHaveValue('First tab $x$.');
  await other.reload(); await expect(other.getByLabel('Paper source', { exact: true })).toHaveValue('Second tab $y$.');
});

test('portable exports round-trip multiple files and invalid temporary edits remain exportable', async ({ page }) => {
  await page.goto('./#device-papers'); await create(page, 'Exported paper');
  await page.getByLabel('Paper source', { exact: true }).fill(SOURCE); await saved(page);
  await revealOptions(page);
  await page.getByRole('button', { name: 'Add source file', exact: true }).click();
  await page.getByLabel('Paper source', { exact: true }).fill('Second file.'); await saved(page);
  await revealOptions(page);
  const downloadWait = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export project', exact: true }).click();
  const download = await downloadWait, payload = await readFile((await download.path())!, 'utf8');
  const exported = JSON.parse(payload); expect(exported.files).toEqual([{ path: 'main.tex', content: SOURCE }, { path: 'section-2.tex', content: 'Second file.' }]);
  expect(Object.keys(exported).sort()).toEqual(['files', 'format', 'title']);
  await page.getByLabel('Source file path', { exact: true }).fill('main.tex');
  await expect(page.getByText('Latest edits are not saved', { exact: true })).toBeVisible();
  const recoveryWait = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export project', exact: true }).click();
  const recovery = JSON.parse(await readFile((await (await recoveryWait).path())!, 'utf8'));
  expect(recovery.recoveryDraft).toBe(true); expect(recovery.files[1].content).toBe('Second file.');
  await page.getByLabel('Source file path', { exact: true }).fill('section-2.tex'); await saved(page);
  await page.getByRole('link', { name: 'All device papers', exact: true }).click();
  await page.getByLabel('Keep papers in this browser profile', { exact: true }).check();
  await page.getByLabel('Import paper files', { exact: true }).setInputFiles({ name: 'backup.paper.json', mimeType: 'application/json', buffer: Buffer.from(payload) });
  await expect(page.getByLabel('Paper source', { exact: true })).toHaveValue(SOURCE);
  await page.getByRole('button', { name: 'section-2.tex', exact: true }).click(); await expect(page.getByLabel('Paper source', { exact: true })).toHaveValue('Second file.');
  await revealOptions(page);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Delete device paper', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved papers', exact: true })).toBeVisible();
  await expect(page.locator('.device-paper-list > a')).toHaveCount(1);
});

test('explicit workspace copies retain exact source without changing the reviewed version', async ({ page, request, baseURL }) => {
  const response = await request.post(new URL('api/revisions', baseURL!).href, { data: { kind: 'paper', title: 'Copy original paper', testPlan: 'Device copy test.', files: [{ path: 'main.tex', content: SOURCE }, { path: 'chapters/proof.tex', content: 'Original proof.' }] } });
  expect(response.ok()).toBe(true); const detail = await response.json() as RevisionDetail;
  await page.goto(`./#${detail.revision.id}`);
  await page.getByRole('button', { name: 'Edit & add version', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'File content', exact: true })).toHaveValue(SOURCE);
  await expectDocumentPreview(page.locator('.paper-version-editor'));
  const paperDetails = page.locator('summary').filter({ hasText: /^Paper details$/ });
  await paperDetails.click();
  await paperDetails.locator('..').getByRole('button', { name: 'Save a device copy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save source files on this device', exact: true })).toBeDisabled();
  await page.getByLabel('Keep this paper accessible on this device after sign-out', { exact: true }).check();
  await page.getByRole('button', { name: 'Save source files on this device', exact: true }).click();
  await page.getByRole('link', { name: 'Open device paper', exact: true }).click();
  await expect(page.getByLabel('Paper source', { exact: true })).toHaveValue(SOURCE);
  await page.getByLabel('Paper source', { exact: true }).fill('Independent local changes $z$.'); await saved(page);
  await page.getByRole('link', { name: 'Workspace papers', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create Paper', exact: true })).toBeVisible();
  const original = await (await request.get(new URL(`api/revisions/${detail.revision.id}`, baseURL!).href)).json() as RevisionDetail;
  expect(original.versions).toHaveLength(1); expect(original.versions[0]!.files[0]!.content).toBe(SOURCE);
});

test('device papers survive workspace sign-out while protected workspace content still requires verification', async ({ page, context, baseURL }) => {
  const url = new URL(baseURL!); url.port = '4312'; url.hash = 'device-papers';
  await page.goto(url.href); await create(page, 'Retained after sign-out'); const paperURL = page.url();
  await page.getByLabel('Paper source', { exact: true }).fill('Private device argument $x^2$.'); await saved(page);
  await page.getByRole('link', { name: 'Workspace papers', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('test-only-alice-password-2026');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.locator('.signed-in-user')).toHaveText('Alice Researcher');
  await page.getByRole('button', { name: 'Sign Out', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Deliberately saved device papers remain');
  await page.getByRole('button', { name: /sign out and clear drafts/i }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open papers on this device', exact: true })).toHaveCount(0);
  await page.goto(paperURL);
  await expect(page.getByText('Ready to reopen offline', { exact: false })).toBeVisible();
  await context.setOffline(true); await page.reload();
  await expect(page.getByLabel('Paper source', { exact: true })).toHaveValue('Private device argument $x^2$.');
  await page.getByRole('link', { name: 'Workspace papers', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^(Workspace locked|Sign in to your workspace)$/ })).toBeVisible();
  await expect(page.locator('.signed-in-user')).toHaveCount(0);
});

test('failed saves retain editable recovery text and insertion uses Windows-text selection correctly', async ({ page }) => {
  await page.goto('./#device-papers');
  await page.getByLabel('Keep papers in this browser profile', { exact: true }).check();
  await page.getByLabel('Import paper files', { exact: true }).setInputFiles({ name: 'windows.tex', mimeType: 'text/plain', buffer: Buffer.from('First\r\nSecond\r\nThird\r\n') });
  const source = page.getByLabel('Paper source', { exact: true }); await expect(source).toBeVisible();
  await source.evaluate(element => { const area = element as HTMLTextAreaElement; area.setSelectionRange(6, 6); });
  await page.locator('summary').filter({ hasText: /^Insert$/ }).click();
  await page.getByRole('button', { name: 'Inline equation', exact: true }).click(); await saved(page);
  await expect(source).toHaveValue('First\n\\(x\\)Second\nThird\n');
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    Object.assign(window, { restoreDeviceWrites: () => { IDBDatabase.prototype.transaction = original; } });
    IDBDatabase.prototype.transaction = function(...args: Parameters<typeof original>) { if (args[1] === 'readwrite') throw new DOMException('Full', 'QuotaExceededError'); return Reflect.apply(original, this, args); };
  });
  await source.fill('Unsaved but exportable $z$.');
  await expect(page.getByRole('alert')).toContainText('insufficient browser storage');
  await expect(page.getByText('Latest edits are not saved', { exact: true })).toBeVisible();
  await revealOptions(page);
  const downloadWait = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export project', exact: true }).click();
  const exported = JSON.parse(await readFile((await (await downloadWait).path())!, 'utf8'));
  expect(exported.files[0].content).toBe('Unsaved but exportable $z$.');
  await page.evaluate(() => (window as unknown as { restoreDeviceWrites: () => void }).restoreDeviceWrites());
  await page.getByRole('button', { name: 'Retry device save', exact: true }).click(); await saved(page);
  await page.reload(); await expect(source).toHaveValue('Unsaved but exportable $z$.');
});

test('math worker timeout retains source and subsequent edits render only the current expression', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Worker.prototype.postMessage;
    Object.assign(window, { holdPaperMath: true });
    Worker.prototype.postMessage = function(message: unknown, ...rest: unknown[]) {
      if ((window as unknown as { holdPaperMath: boolean }).holdPaperMath && message && typeof message === 'object' && 'requests' in message) return;
      return Reflect.apply(original, this, [message, ...rest]);
    };
  });
  await page.goto('./#device-papers'); await create(page, 'Worker recovery');
  const source = page.getByLabel('Paper source', { exact: true });
  await source.fill('Keep $a^2$.'); await saved(page);
  await expect(page.getByText('This preview took too long.', { exact: false })).toBeVisible();
  await expect(page.locator('.paper-math-fallback')).toContainText('$a^2$');
  await source.fill('Still editable $b^2$.'); await saved(page);
  await page.evaluate(() => Object.assign(window, { holdPaperMath: false }));
  await source.fill('Current $c^2$.');
  await expect(page.locator('.katex annotation')).toHaveText('c^2');
  await expect(source).toHaveValue('Current $c^2$.');
  expect(await page.locator('.katex annotation').allTextContents()).not.toContain('a^2');
});

test('workspace draft warnings and cross-tab sign-out stay active while the device library is open', async ({ page, context, baseURL }) => {
  const url = new URL(baseURL!); url.port = '4312'; url.hash = 'home';
  await page.goto(url.href);
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('test-only-alice-password-2026');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.getByRole('button', { name: 'Create Task', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Title', { exact: true }).fill('Unpublished workspace draft');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => { location.hash = 'device-papers'; });
  await expect(page.getByRole('heading', { name: 'Papers on this device', exact: true })).toBeVisible();
  const warn = () => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  await expect.poll(warn).toBe(true);
  const other = await context.newPage(); await other.goto(url.href);
  await expect(other.locator('.signed-in-user')).toHaveText('Alice Researcher');
  await other.getByRole('button', { name: 'Sign Out', exact: true }).click();
  await other.getByRole('button', { name: /sign out and clear drafts/i }).click();
  await expect(other.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible();
  await expect.poll(warn).toBe(false);
  await expect(page.getByRole('heading', { name: 'Papers on this device', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Workspace papers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace', exact: true })).toBeVisible();
});

test('a fresh browser process reopens the saved profile and paper with the network disconnected', async ({ baseURL }, info) => {
  const directory = await mkdtemp(join(tmpdir(), 'device-paper-profile-'));
  const options = { headless: true, viewport: info.project.use.viewport, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : process.env.CI ? {} : { channel: 'chrome' }) };
  let browser = await chromium.launchPersistentContext(directory, options);
  try {
    const url = new URL(baseURL!); url.port = '4312'; url.hash = 'device-papers';
    const page = browser.pages()[0]!; await page.goto(url.href);
    await expect(page.getByText('Ready to reopen offline', { exact: false })).toBeVisible({ timeout: 20000 });
    await create(page, 'Browser restart');
    await page.getByLabel('Paper source', { exact: true }).fill(SOURCE); await saved(page);
    const paperURL = page.url(); await browser.close();
    browser = await chromium.launchPersistentContext(directory, options); await browser.setOffline(true);
    const reopened = browser.pages()[0]!; await reopened.goto(paperURL);
    await expect(reopened.getByLabel('Paper source', { exact: true })).toHaveValue(SOURCE);
    await expect(reopened.locator('.katex')).toHaveCount(2);
    await reopened.getByLabel('Paper source', { exact: true }).fill(SOURCE + 'After restarting the browser.'); await saved(reopened);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); }
});
