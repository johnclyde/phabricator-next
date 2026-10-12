import { test, expect, type APIRequestContext, type Page, type Request } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AppState, RevisionDetail, RevisionKind, SourceFile } from '../shared/types';
import type { FileRecord } from '../shared/files';
import { notificationInput } from '../shared/notifications';
import { openComparisonOptions } from './comparison-ui';

const A = 'Alpha evidence establishes the first distinct claim.';
const B = 'Beta testimony independently supports the second finding.';
const C = 'Gamma authorities preserve the unchanged conclusion.';
const paragraphs = (...values: string[]) => values.join('\n\n') + '\n\n';
const original = paragraphs(A, B, C), reordered = paragraphs(B, A, C);
async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> {
  const url = new URL(`api${path}`, baseURL).href;
  const response = body === undefined ? await request.get(url) : await request.post(url, { data: body, headers: { 'Idempotency-Key': randomUUID() } });
  expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>;
}
async function fixture(request: APIRequestContext, baseURL: string, kind: RevisionKind = 'document', before: SourceFile[] = [{ path: 'motion.md', content: original }], after: SourceFile[] = [{ path: 'motion.md', content: reordered }]) {
  const first = await api<RevisionDetail>(request, baseURL, '/revisions', { kind, title: `Paragraph navigation ${randomUUID()}`, testPlan: 'Verify exact source paragraphs and immutable review evidence.', files: before });
  await api(request, baseURL, `/revisions/${first.revision.id}/versions`, { expectedVersion: 1, message: 'Reorder exact source paragraphs', files: after });
  return api<RevisionDetail>(request, baseURL, `/revisions/${first.revision.id}`);
}
async function open(page: Page, id: string) { await page.goto(`./#${id}`); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2'); }
async function align(page: Page) { await openComparisonOptions(page); await page.getByLabel('Align source paragraphs', { exact: true }).check(); await expect(page.locator('.comparison-identity')).toContainText('Source paragraph alignment'); }
async function literalText(page: Page) {
  return page.getByLabel('Selected file comparison', { exact: true }).evaluate(element => {
    const segments = [...element.querySelectorAll('[data-comparison-segment]')];
    return { before: segments.filter(segment => segment.tagName !== 'INS').map(segment => segment.textContent ?? '').join(''), after: segments.filter(segment => segment.tagName !== 'DEL').map(segment => segment.textContent ?? '').join('') };
  });
}
async function savedSelection(page: Page, id: string) {
  return page.evaluate(id => {
    const key = Object.keys(localStorage).find(key => key.endsWith(`:revision-comparison:${id}`));
    if (!key) throw new Error('Expected a local immutable comparison selection.');
    return JSON.parse(localStorage.getItem(key)!);
  }, id) as Promise<{ revisionId: string; base: { id: string; contentHash: string } | null; target: { id: string; contentHash: string }; filePath: string; mode: string; view: string; paragraphAlignment?: boolean }>;
}
function onlyNotificationReads(writes: Request[], id: string) {
  for (const write of writes) {
    expect(new URL(write.url()).pathname).toMatch(/\/api\/notifications\/read$/);
    expect(write.method()).toBe('POST'); expect(notificationInput(write.postDataJSON())).toMatchObject({ action: 'read_object', objectId: id });
  }
}
async function command(page: Page, text: string) { await page.getByLabel('Workspace command', { exact: true }).fill(text); await page.getByRole('button', { name: 'Run', exact: true }).click(); }

test('exact unique paragraph moves reconstruct both sources and preserve comments, drafts and deterministic evidence', async ({ page, request, baseURL }, info) => {
  const detail = await fixture(request, baseURL!), id = detail.revision.id, version = detail.versions.find(item => item.number === 2)!;
  await api(request, baseURL!, `/revisions/${id}/comments`, { versionId: version.id, filePath: 'motion.md', line: 1, body: 'An existing comment stays on the exact target line.' });
  // The local route runs deterministic checks only; no AI adapter is invoked.
  await api(request, baseURL!, `/revisions/${id}/reviews`, { provider: 'local', expectedVersion: 2 });
  const before = await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`), writes: Request[] = [];
  page.on('request', row => { if (row.method() !== 'GET') writes.push(row); });
  await open(page, id); await openComparisonOptions(page);
  await expect(page.getByLabel('Align source paragraphs', { exact: true })).not.toBeChecked();
  await expect(page.locator('.paragraph-reorder')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Review comment', exact: true }).fill('Retain this unsubmitted target-version comment.');
  await page.getByRole('button', { name: 'Edit & add version', exact: true }).click();
  await page.getByRole('textbox', { name: 'File content', exact: true }).fill('Retain this unsubmitted source edit.');
  await align(page);
  await expect.poll(() => literalText(page)).toEqual({ before: original, after: reordered });
  await expect(page.locator('.paragraph-alignment-note')).toContainText('Exact paragraph match; source paragraphs, not rendered structure.');
  const annotations = page.locator('.paragraph-reorder'); await expect(annotations).toHaveCount(2);
  const first = annotations.first(), pair = await first.getAttribute('data-paragraph-id'), side = await first.getAttribute('data-paragraph-side');
  expect(pair).toBeTruthy(); expect(['before', 'after']).toContain(side);
  const counterpart = annotations.filter({ has: page.getByRole('button', { name: side === 'before' ? /^Show removed paragraph / : /^Show added paragraph / }) });
  await expect(counterpart).toHaveAttribute('data-paragraph-id', pair!);
  const action = first.getByRole('button', { name: /^Show (?:added|removed) paragraph / });
  if (info.project.name === 'mobile') expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await action.click();
  await expect(page.locator('.paragraph-match-text:focus')).toHaveCount(1);
  await expect(page.locator('.paragraph-match-text:focus')).toHaveAttribute('data-paragraph-id', pair!);
  await expect(page.locator('.paragraph-match-text:focus')).toHaveAttribute('data-paragraph-side', side === 'before' ? 'after' : 'before');
  const focused = await page.locator('.paragraph-match-text:focus').textContent(); expect([A, B]).toContain(focused);
  await expect(page.locator('.paragraph-match-text:focus')).toBeInViewport();
  await expect(page.getByRole('textbox', { name: 'Review comment', exact: true })).toHaveValue('Retain this unsubmitted target-version comment.');
  await expect(page.getByRole('textbox', { name: 'File content', exact: true })).toHaveValue('Retain this unsubmitted source edit.');
  await expect.poll(() => literalText(page)).toEqual({ before: original, after: reordered });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('paragraph-counterpart.png') });
  await openComparisonOptions(page); await page.getByLabel('Align source paragraphs', { exact: true }).uncheck();
  await expect(page.locator('.paragraph-reorder')).toHaveCount(0);
  const after = await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`);
  expect(after.versions).toEqual(before.versions); expect(after.comments).toEqual(before.comments); expect(after.reviews).toEqual(before.reviews);
  expect(after.revision).toEqual(before.revision); onlyNotificationReads(writes, id);
});

test('multiple exact reordered paragraphs sharing a segment retain source order on both sides', async ({ page, request, baseURL }) => {
  const values = [A, B, C, 'Delta appendix states a fourth unique source paragraph.'];
  const before = paragraphs(...values), after = paragraphs(...[...values].reverse());
  const detail = await fixture(request, baseURL!, 'document', [{ path: 'motion.md', content: before }], [{ path: 'motion.md', content: after }]);
  await open(page, detail.revision.id); await align(page);
  await expect.poll(() => literalText(page)).toEqual({ before, after });
  const annotations = page.locator('.paragraph-reorder'); await expect(annotations).toHaveCount(6);
  for (let index = 0; index < 6; index++) {
    const marker = annotations.nth(index), id = await marker.getAttribute('data-paragraph-id'), side = await marker.getAttribute('data-paragraph-side');
    const source = await page.locator(`.paragraph-match-text[data-paragraph-id="${id}"][data-paragraph-side="${side}"]`).textContent();
    await marker.getByRole('button', { name: /^Show (?:added|removed) paragraph / }).click();
    const focused = page.locator('.paragraph-match-text:focus');
    await expect(focused).toHaveAttribute('data-paragraph-id', id!);
    await expect(focused).toHaveAttribute('data-paragraph-side', side === 'before' ? 'after' : 'before');
    await expect(focused).toHaveText(source!);
  }
  await expect.poll(() => literalText(page)).toEqual({ before, after });
});

test('repeated and edited paragraphs remain literal changes without guessed move counterparts', async ({ page, request, baseURL }) => {
  const repeat = 'Repeated wording must never identify a unique source paragraph.';
  const before = [{ path: 'repeated.md', content: paragraphs(A, repeat, B, C, repeat, 'Delta anchor remains.', 'Epsilon anchor remains.', 'Zeta anchor remains.') }, { path: 'edited.md', content: paragraphs('An old movable claim.', A, B, C) }];
  const after = [{ path: 'repeated.md', content: paragraphs(A, repeat, B, C, 'Delta anchor remains.', 'Epsilon anchor remains.', 'Zeta anchor remains.', repeat) }, { path: 'edited.md', content: paragraphs(A, B, 'A revised movable claim.', C) }];
  const detail = await fixture(request, baseURL!, 'document', before, after); await open(page, detail.revision.id); await align(page);
  for (const [index, file] of before.entries()) {
    await page.getByLabel('Source file', { exact: true }).selectOption(file.path);
    await expect.poll(() => literalText(page)).toEqual({ before: file.content, after: after[index]!.content });
    await expect(page.locator('.paragraph-reorder')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Show (?:added|removed) paragraph / })).toHaveCount(0);
  }
});

interface HeldAnimation {
  callbacks: FrameRequestCallback[]; scrolls: number; restore: () => void;
}
test('delayed counterpart scrolling retires when its file or immutable version changes', async ({ page, request, baseURL }) => {
  const otherBefore = paragraphs('Other file old statement.'), otherAfter = paragraphs('Other file current statement.');
  const detail = await fixture(request, baseURL!, 'document', [{ path: 'motion.md', content: original }, { path: 'other.md', content: otherBefore }], [{ path: 'motion.md', content: reordered }, { path: 'other.md', content: otherAfter }]);
  await open(page, detail.revision.id); await align(page);
  for (const transition of ['file', 'version'] as const) {
    await page.getByLabel('Source file', { exact: true }).selectOption('motion.md');
    await page.getByLabel('Version to inspect', { exact: true }).selectOption('2');
    await expect(page.locator('.paragraph-reorder')).toHaveCount(2);
    await page.evaluate(() => {
      const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame, scroll = Element.prototype.scrollIntoView;
      const held: HeldAnimation = { callbacks: [], scrolls: 0, restore: () => { window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel; Element.prototype.scrollIntoView = scroll; } };
      (window as unknown as { paragraphAnimation: HeldAnimation }).paragraphAnimation = held;
      window.requestAnimationFrame = callback => { held.callbacks.push(callback); return held.callbacks.length; };
      window.cancelAnimationFrame = () => {}; // Exercise stale callback guards even if cancellation raced.
      Element.prototype.scrollIntoView = function () { if (this.matches('.paragraph-match-text')) held.scrolls++; };
    });
    try {
      // DOM click avoids Playwright's own actionability animation frames being held.
      await page.locator('.paragraph-reorder').first().getByRole('button', { name: /^Show (?:added|removed) paragraph / }).evaluate(element => (element as HTMLButtonElement).click());
      expect(await page.evaluate(() => (window as unknown as { paragraphAnimation: HeldAnimation }).paragraphAnimation.callbacks.length)).toBeGreaterThan(0);
      const control = page.getByLabel(transition === 'file' ? 'Source file' : 'Version to inspect', { exact: true });
      await control.selectOption(transition === 'file' ? 'other.md' : '1');
      const expected = transition === 'file' ? { before: otherBefore, after: otherAfter } : { before: original, after: original };
      await expect.poll(() => literalText(page)).toEqual(expected);
      const selected = await savedSelection(page, detail.revision.id), progress = await page.locator('.passage-navigation').textContent();
      await page.evaluate(() => { const held = (window as unknown as { paragraphAnimation: HeldAnimation }).paragraphAnimation; const callbacks = held.callbacks.splice(0); for (const callback of callbacks) callback(performance.now()); });
      expect(await page.evaluate(() => (window as unknown as { paragraphAnimation: HeldAnimation }).paragraphAnimation.scrolls)).toBe(0);
      expect(await savedSelection(page, detail.revision.id)).toEqual(selected);
      await expect(page.locator('.passage-navigation')).toHaveText(progress!);
      await expect.poll(() => literalText(page)).toEqual(expected);
    } finally { await page.evaluate(() => (window as unknown as { paragraphAnimation?: HeldAnimation }).paragraphAnimation?.restore()); }
  }
});

test('aligned historical paper selections survive new heads and saved offline reopening', async ({ page, request, baseURL, context }) => {
  const detail = await fixture(request, baseURL!, 'paper'); await open(page, detail.revision.id); await align(page);
  const selected = await savedSelection(page, detail.revision.id); expect(selected.paragraphAlignment).toBe(true);
  await api(request, baseURL!, `/revisions/${detail.revision.id}/versions`, { expectedVersion: 2, files: [{ path: 'latest.tex', content: 'New head is not this comparison.' }], message: 'A newer source version' });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Version to inspect', { exact: true }).locator('option[value="3"]')).toHaveCount(1);
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
  expect(await savedSelection(page, detail.revision.id)).toEqual(selected);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await context.setOffline(true);
  try {
    await page.reload(); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
    await expect(page.getByLabel('Base version', { exact: true })).toHaveValue('1');
    await openComparisonOptions(page); await expect(page.getByLabel('Align source paragraphs', { exact: true })).toBeChecked();
    await expect.poll(() => literalText(page)).toEqual({ before: original, after: reordered });
    await expect(page.locator('.paragraph-reorder')).toHaveCount(2);
    expect(await savedSelection(page, detail.revision.id)).toEqual(selected);
  } finally { await context.setOffline(false); }
});

test('paragraph alignment is absent for code and Word projections, and hidden in line mode', async ({ page, request, baseURL }) => {
  const code = await fixture(request, baseURL!, 'code'); await open(page, code.revision.id); await openComparisonOptions(page);
  await expect(page.getByLabel('Align source paragraphs', { exact: true })).toHaveCount(0);
  await page.getByLabel('Comparison mode', { exact: true }).selectOption('words');
  await expect(page.getByLabel('Align source paragraphs', { exact: true })).toHaveCount(0);
  const prose = await fixture(request, baseURL!); await open(page, prose.revision.id); await align(page);
  await page.getByLabel('Comparison mode', { exact: true }).selectOption('lines');
  await expect(page.getByLabel('Align source paragraphs', { exact: true })).toHaveCount(0); await expect(page.locator('.paragraph-reorder')).toHaveCount(0);
  await page.getByLabel('Comparison mode', { exact: true }).selectOption('words');
  await expect(page.getByLabel('Align source paragraphs', { exact: true })).toBeChecked(); await expect(page.locator('.paragraph-reorder')).toHaveCount(2);
  const bytes = await readFile('tests/fixtures/docx/roundtrip.docx'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = await api<FileRecord>(request, baseURL!, '/files', { name: 'paragraph-exclusion.docx', dataBase64: bytes.toString('base64'), bytes: bytes.length, sha256 });
  const state = await api<AppState>(request, baseURL!, '/state');
  const word = await api<RevisionDetail>(request, baseURL!, '/revisions/docx', { title: 'Word projection alignment exclusion', testPlan: 'Verify source paragraph alignment is not offered for Word projections.', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: false, expectedAccessEpoch: state.accessEpoch });
  await page.goto(`./#${word.revision.id}`); await page.getByRole('button', { name: 'Compare Word Versions', exact: true }).click(); await openComparisonOptions(page, true);
  await expect(page.getByLabel('Align source paragraphs', { exact: true })).toHaveCount(0); await expect(page.locator('.paragraph-reorder')).toHaveCount(0);
});

test('on-device narration follows the aligned counterpart cursor and retires on file change', async ({ page, request, baseURL }) => {
  await page.addInitScript(() => {
    const state = { active: '', texts: [] as string[], cancels: 0 };
    Object.assign(window, { paragraphSpeech: state, SpeechSynthesisUtterance: class { text: string; constructor(text: string) { this.text = text; } } });
    Object.defineProperty(window, 'speechSynthesis', { value: { speaking: false, getVoices: () => [{ localService: true, lang: 'en-US', name: 'On-device fixture voice' }], addEventListener() {}, removeEventListener() {}, cancel() { state.active = ''; state.cancels++; }, speak(utterance: { text: string }) { state.active = utterance.text; state.texts.push(utterance.text); } } });
  });
  const detail = await fixture(request, baseURL!, 'document', [{ path: 'motion.md', content: original }, { path: 'other.md', content: 'Other unchanged source.' }], [{ path: 'motion.md', content: reordered }, { path: 'other.md', content: 'Other unchanged source.' }]);
  await open(page, detail.revision.id); await align(page);
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click(); await page.getByLabel('Speak responses (on-device only)', { exact: true }).check();
  await page.locator('.paragraph-reorder').first().getByRole('button', { name: /^Show (?:added|removed) paragraph / }).click();
  await expect(page.locator('.paragraph-match-text:focus')).toHaveCount(1);
  const matched = await page.locator('.paragraph-match-text:focus').textContent(), progress = (await page.locator('.passage-navigation').textContent())!.match(/Change (\d+) of (\d+)/)!;
  expect(matched).toBeTruthy(); expect(progress).toBeTruthy();
  await command(page, 'read current change');
  await expect(page.locator('.command-feedback')).toContainText(`Change ${progress[1]} of ${progress[2]}`);
  await expect(page.locator('.command-feedback')).toContainText(matched!);
  const speech = () => page.evaluate(() => (window as unknown as { paragraphSpeech: { active: string } }).paragraphSpeech.active);
  expect(await speech()).toContain('version 1 to version 2, file motion.md'); expect(await speech()).toContain(matched!);
  await page.getByLabel('Source file', { exact: true }).selectOption('other.md'); await expect.poll(speech).toBe('');
  await command(page, 'read current change'); await expect(page.locator('.command-feedback')).toContainText('No text changes');
  expect(await speech()).not.toContain(matched!);
  const after = await api<RevisionDetail>(request, baseURL!, `/revisions/${detail.revision.id}`);
  expect(after.versions).toEqual(detail.versions); expect(after.comments).toEqual(detail.comments); expect(after.reviews).toEqual(detail.reviews);
});
