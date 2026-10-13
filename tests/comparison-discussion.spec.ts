import { test, expect, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AppState, RevisionDetail, RevisionKind, ReviewComment, SourceFile } from '../shared/types';
import type { FileRecord } from '../shared/files';
import type { ObjectAccess } from '../shared/policy';
import type { ReviewDraftSnapshot } from '../shared/review-drafts';
import { openComparisonOptions } from './comparison-ui';
import { reviewerApi as api, reviewerSignIn as signIn } from './revision-reviewers-browser';

const beforeText = 'First stable observation.\n\nThe former argument cites an obsolete authority.\n\nFinal stable conclusion.\n';
const afterText = 'First stable observation.\n\nThe revised argument cites a precise authority.\n\nFinal stable conclusion.\n';
const removedText = 'Discarded affidavit: β evidence 😀.\r\nA second exact line.\r\n';
const composer = (page: Page) => page.locator('.comment-form');
const comment = (page: Page) => composer(page).getByLabel('Review comment', { exact: true });
const destination = (page: Page) => page.getByLabel('Comment version', { exact: true });
const privateTray = (page: Page) => page.getByRole('region', { name: 'Pending private review', exact: true });

async function fixture(page: Page, title: string, kind: RevisionKind = 'document', before: SourceFile[] = [{ path: 'motion.md', content: beforeText }, { path: 'removed.txt', content: removedText }], after: SourceFile[] = [{ path: 'motion.md', content: afterText }]) {
  await page.goto('./#home');
  const created = await api<RevisionDetail>(page, '/revisions', { title: `${title} ${randomUUID()}`, kind, testPlan: 'Verify immutable source-side comments, retained drafts, and exact review evidence.', files: before });
  await api(page, `/revisions/${created.revision.id}/versions`, { expectedVersion: 1, message: 'Revise the source and remove an original file', files: after });
  return api<RevisionDetail>(page, `/revisions/${created.revision.id}`);
}
async function open(page: Page, id: string, target = '2') {
  await page.goto(`./#${id}`); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue(target);
  await expect(composer(page)).toHaveCount(1);
}
async function pair(page: Page) {
  return { base: await page.getByLabel('Base version', { exact: true }).inputValue(), target: await page.getByLabel('Version to inspect', { exact: true }).inputValue(), path: await page.getByLabel('Source file', { exact: true }).inputValue() };
}
async function openPrivate(page: Page) {
  const details = privateTray(page).locator(':scope > details');
  if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator(':scope > summary').click();
}
function evidence(detail: RevisionDetail) { return { versions: detail.versions, reviews: detail.reviews, revision: detail.revision, suggestionApplications: detail.suggestionApplications }; }
function exactAnchor(detail: RevisionDetail, value: ReviewComment, versionNumber: number, path: string) {
  const version = detail.versions.find(item => item.number === versionNumber)!, source = version.files.find(item => item.path === path)!.content;
  expect(value.versionId).toBe(version.id); expect(value.filePath).toBe(path);
  expect(value.anchor).toMatchObject({ versionId: version.id, contentHash: version.contentHash, filePath: path });
  expect(value.anchor!.end).toBeGreaterThan(value.anchor!.start);
  expect(source.slice(value.anchor!.start, value.anchor!.end)).toBe(value.anchor!.quote);
}

test('a deleted LaTeX file can receive an exact historical suggestion and reversed-side comments without changing the pair', async ({ page }, info) => {
  const latex = '\\documentclass{article}\n\\begin{document}\nAn original statement.\n\\end{document}\n';
  const detail = await fixture(page, 'Deleted manuscript discussion', 'paper', [{ path: 'main.tex', content: latex }, { path: 'removed.tex', content: removedText }], [{ path: 'main.tex', content: latex.replace('original', 'revised') }]);
  const id = detail.revision.id, original = detail.versions.find(item => item.number === 1)!;
  // This is a deterministic local check, not an external AI operation.
  await api(page, `/revisions/${id}/reviews`, { provider: 'local', expectedVersion: 2 });
  const baseline = await api<RevisionDetail>(page, `/revisions/${id}`);
  await open(page, id); await page.getByLabel('Source file', { exact: true }).selectOption('removed.tex');
  const selected = await pair(page), removed = page.getByRole('button', { name: 'Comment on removed text · Version 1', exact: true }).first();
  await expect(removed).toBeEnabled();
  if (info.project.name === 'mobile') expect((await removed.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await removed.click(); await expect(destination(page)).toHaveValue(original.id);
  await expect(composer(page).locator('.thread-quotation')).toHaveText(removedText);
  await comment(page).fill('This removed affidavit needs a more precise replacement.');
  await composer(page).getByRole('checkbox', { name: 'Suggest an edit', exact: true }).check();
  await composer(page).getByLabel('Suggested replacement', { exact: true }).fill('A proposed historical replacement.\n');
  await composer(page).getByRole('button', { name: 'Add Suggested Edit', exact: true }).click();
  await expect(comment(page)).toHaveValue(''); expect(await pair(page)).toEqual(selected);
  let result = await api<RevisionDetail>(page, `/revisions/${id}`);
  expect(result.comments).toHaveLength(1); const root = result.comments[0]!;
  exactAnchor(result, root, 1, 'removed.tex'); expect(root.anchor).toMatchObject({ start: 0, end: removedText.length, quote: removedText });
  expect(root.suggestion).toEqual({ replacement: 'A proposed historical replacement.\n' });
  const inline = page.locator(`[data-comparison-thread-id="${root.id}"]`);
  await expect(inline).toHaveCount(1); await expect(inline).toContainText(root.body);
  await page.getByRole('button', { name: 'History', exact: true }).click(); await expect(composer(page)).toHaveCount(1); await expect(comment(page)).toBeVisible();
  await inline.getByRole('button', { name: 'Open discussion', exact: true }).click();
  const thread = page.locator(`.review-thread[data-thread-id="${root.id}"]`);
  await expect(thread).toHaveCount(1); await expect(thread).toBeFocused();
  await expect(thread.getByRole('button', { name: 'Review Suggested Edit', exact: true })).toBeDisabled();
  expect(await pair(page)).toEqual(selected); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('historical-inline-discussion.png') });
  await openComparisonOptions(page); await page.getByRole('button', { name: 'Swap versions', exact: true }).click();
  const reversed = await pair(page); expect(reversed).toEqual({ base: '2', target: '1', path: 'removed.tex' });
  await page.getByRole('button', { name: 'Comment on added text · Version 1', exact: true }).click();
  await expect(destination(page)).toHaveValue(original.id); await expect(composer(page).locator('.thread-quotation')).toHaveText(removedText);
  await comment(page).fill('Reversed comparison still refers to the same immutable source.');
  await composer(page).getByRole('button', { name: 'Add Comment', exact: true }).click(); await expect(comment(page)).toHaveValue('');
  result = await api<RevisionDetail>(page, `/revisions/${id}`); expect(result.comments).toHaveLength(2);
  exactAnchor(result, result.comments[1]!, 1, 'removed.tex'); expect(evidence(result)).toEqual(evidence(baseline)); expect(await pair(page)).toEqual(reversed);
});

test('removed and added passages and both line gutters retain their exact immutable side', async ({ page }, info) => {
  const detail = await fixture(page, 'Side-specific passage discussion'), id = detail.revision.id;
  await open(page, id);
  for (const [side, number] of [['removed', 1], ['added', 2]] as const) {
    await page.getByRole('button', { name: `Comment on ${side} text · Version ${number}`, exact: true }).first().click();
    await comment(page).fill(`A comment on the ${side} passage.`);
    await composer(page).getByRole('button', { name: 'Add Comment', exact: true }).click(); await expect(comment(page)).toHaveValue('');
    const result = await api<RevisionDetail>(page, `/revisions/${id}`), saved = result.comments.find(item => item.body === `A comment on the ${side} passage.`)!;
    exactAnchor(result, saved, number, 'motion.md');
    expect(saved.anchor!.quote).toContain(side === 'removed' ? 'former' : 'revised');
    expect(await pair(page)).toEqual({ base: '1', target: '2', path: 'motion.md' });
  }
  const actions = page.getByRole('group', { name: 'Active change comment actions', exact: true });
  await expect(actions.getByRole('button')).toHaveCount(2);
  await page.getByRole('button', { name: 'Next change', exact: true }).click();
  await actions.getByRole('button', { name: 'Comment on removed text · Version 1', exact: true }).click();
  await expect(composer(page).locator('.thread-quotation')).toHaveText('an');
  expect(await pair(page)).toEqual({ base: '1', target: '2', path: 'motion.md' });
  await page.locator('.revision-comparison-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('source-side-discussion.png') });
  await openComparisonOptions(page); await page.getByLabel('Comparison mode', { exact: true }).selectOption('lines');
  await page.getByRole('button', { name: 'Comment on base line 3 · Version 1', exact: true }).click();
  await expect(destination(page)).toHaveValue(detail.versions[0]!.id); await expect(composer(page).locator('.thread-quotation')).toHaveText('The former argument cites an obsolete authority.');
  await comment(page).fill('A comment on the original line.'); await composer(page).getByRole('button', { name: 'Add Comment', exact: true }).click(); await expect(comment(page)).toHaveValue('');
  await page.getByRole('button', { name: 'Comment on line 3', exact: true }).click();
  await expect(destination(page)).toHaveValue(detail.versions[1]!.id); await expect(composer(page).locator('.thread-quotation')).toHaveText('The revised argument cites a precise authority.');
  await comment(page).fill('A comment on the revised line.'); await composer(page).getByRole('button', { name: 'Add Comment', exact: true }).click(); await expect(comment(page)).toHaveValue('');
  const result = await api<RevisionDetail>(page, `/revisions/${id}`); expect(result.comments).toHaveLength(4);
  expect(result.comments[2]).toMatchObject({ versionId: detail.versions[0]!.id, filePath: 'motion.md', line: 3 });
  expect(result.comments[3]).toMatchObject({ versionId: detail.versions[1]!.id, filePath: 'motion.md', line: 3 });
  expect(evidence(result)).toEqual(evidence(detail));
  await page.locator('.literal-line-diff').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (info.project.name === 'mobile') for (const name of ['Comment on base line 3 · Version 1', 'Comment on line 3']) {
    const bounds = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
    expect(bounds.height).toBeGreaterThanOrEqual(44); expect(bounds.width).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: info.outputPath('source-side-line-discussion.png') });
});

test('one composer retains independent source-side drafts and anchors through tabs and offline reopening', async ({ page, context }) => {
  const detail = await fixture(page, 'Offline side drafts'), id = detail.revision.id, base = detail.versions[0]!, target = detail.versions[1]!;
  await open(page, id); const selected = await pair(page);
  await page.getByRole('button', { name: 'Comment on added text · Version 2', exact: true }).first().click(); await comment(page).fill('Unsent target-side draft.');
  const targetQuote = await composer(page).locator('.thread-quotation').textContent();
  await page.getByRole('button', { name: 'Comment on removed text · Version 1', exact: true }).first().click(); await comment(page).fill('Unsent base-side draft.');
  const baseQuote = await composer(page).locator('.thread-quotation').textContent();
  await page.getByRole('button', { name: 'History', exact: true }).click(); await expect(composer(page)).toHaveCount(1); await expect(comment(page)).toHaveValue('Unsent base-side draft.');
  await destination(page).selectOption(target.id); await expect(comment(page)).toHaveValue('Unsent target-side draft.'); await expect(composer(page).locator('.thread-quotation')).toHaveText(targetQuote!);
  await destination(page).selectOption(base.id); await expect(comment(page)).toHaveValue('Unsent base-side draft.'); await expect(composer(page).locator('.thread-quotation')).toHaveText(baseQuote!);
  await expect.poll(() => page.evaluate(({ id, versions }) => versions.map(version => {
    const key = Object.keys(localStorage).find(key => key.endsWith(`:comment-source:${id}:${version}`)); return key ? JSON.parse(localStorage.getItem(key)!).body : null;
  }), { id, versions: [base.id, target.id] })).toEqual(['Unsent base-side draft.', 'Unsent target-side draft.']);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  let sourceWrites = 0; page.on('request', request => { if (request.method() !== 'GET' && /\/api\/revisions\/[^/]+\/(?:comments|review-drafts|versions)(?:\/|$)/.test(new URL(request.url()).pathname)) sourceWrites++; });
  await context.setOffline(true);
  try {
    await page.reload(); await expect(destination(page)).toHaveValue(target.id); await expect(comment(page)).toHaveValue('Unsent target-side draft.');
    await destination(page).selectOption(base.id); await expect(comment(page)).toHaveValue('Unsent base-side draft.'); await expect(composer(page).locator('.thread-quotation')).toHaveText(baseQuote!);
    await destination(page).selectOption(target.id); await expect(comment(page)).toHaveValue('Unsent target-side draft.'); await expect(composer(page)).toHaveCount(1); expect(await pair(page)).toEqual(selected);
  } finally { await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); }
  expect(sourceWrites).toBe(0); const result = await api<RevisionDetail>(page, `/revisions/${id}`); expect(result.comments).toEqual([]); expect(evidence(result)).toEqual(evidence(detail));
});

for (const privateSave of [false, true]) test(`a delayed ${privateSave ? 'private' : 'public'} source-side save pins one composer while the comparison changes`, async ({ page }) => {
  const detail = await fixture(page, `${privateSave ? 'Private' : 'Public'} side save race`), id = detail.revision.id, base = detail.versions[0]!;
  await api(page, `/revisions/${id}/versions`, { expectedVersion: 2, message: 'A third immutable draft', files: [{ path: 'motion.md', content: afterText.replace('precise', 'latest') }] });
  const baseline = await api<RevisionDetail>(page, `/revisions/${id}`), latest = baseline.versions.find(item => item.number === 3)!;
  await open(page, id, '3'); await page.getByLabel('Base version', { exact: true }).selectOption('1'); await page.getByLabel('Version to inspect', { exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Comment on removed text · Version 1', exact: true }).first().click();
  await comment(page).fill(`Exact ${privateSave ? 'private' : 'public'} comment on version one.`);
  const quote = await composer(page).locator('.thread-quotation').textContent();
  if (privateSave) await openPrivate(page);
  let release!: () => void, arrived!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), received = new Promise<void>(resolve => { arrived = resolve; });
  const pattern = privateSave ? `**/api/revisions/${id}/review-drafts/*` : `**/api/revisions/${id}/comments`;
  let writes = 0;
  await page.route(pattern, async route => {
    if (route.request().method() !== (privateSave ? 'PUT' : 'POST')) return route.continue();
    writes++; const response = await route.fetch(); expect(response.ok()).toBe(true); arrived(); await gate; await route.fulfill({ response });
  });
  try {
    const submit = composer(page).getByRole('button', { name: privateSave ? 'Save Private Draft' : 'Add Comment', exact: true });
    await expect(submit).toBeEnabled(); await submit.click(); await received;
    await expect(destination(page)).toBeDisabled(); await expect(comment(page)).toBeDisabled();
    await page.getByLabel('Base version', { exact: true }).selectOption('2'); await page.getByLabel('Version to inspect', { exact: true }).selectOption('3');
    await expect(destination(page)).toHaveValue(base.id); await expect(destination(page).locator(`option[value="${base.id}"]`)).toHaveText('Version 1 · Retained comment draft');
    await expect(composer(page)).toHaveCount(1); await expect(composer(page).locator('.thread-quotation')).toHaveText(quote!);
    await expect(page.getByRole('button', { name: 'Comment on added text · Version 3', exact: true }).first()).toBeDisabled();
    await page.getByRole('button', { name: 'History', exact: true }).click(); await expect(comment(page)).toBeDisabled();
    release();
    await expect(comment(page)).toHaveValue(''); await page.unroute(pattern); await expect(destination(page)).toBeEnabled(); await expect(composer(page)).toHaveCount(1);
    expect(writes).toBe(1); expect(await pair(page)).toEqual({ base: '2', target: '3', path: 'motion.md' });
    await expect(composer(page).getByRole('button', { name: 'Add Comment', exact: true })).toBeDisabled();
    if (privateSave) {
      let snapshot = await api<ReviewDraftSnapshot>(page, `/revisions/${id}/review-drafts`); expect(snapshot.entries).toHaveLength(1); expect(snapshot.entries[0]!.payload).toMatchObject({ kind: 'comment', versionId: base.id, passage: { quote } });
      expect((await api<RevisionDetail>(page, `/revisions/${id}`)).comments).toEqual([]);
      await destination(page).selectOption(latest.id); await comment(page).fill('A separate current-version private comment.');
      await composer(page).getByRole('button', { name: 'Save Private Draft', exact: true }).click(); await expect(comment(page)).toHaveValue('');
      snapshot = await api<ReviewDraftSnapshot>(page, `/revisions/${id}/review-drafts`); expect(snapshot.entries).toHaveLength(2);
      await privateTray(page).getByRole('button', { name: 'Preview complete review', exact: true }).click();
      const preview = privateTray(page).getByRole('region', { name: 'Complete private review preview', exact: true }); await expect(preview.locator('article')).toHaveCount(2);
      await destination(page).selectOption(detail.versions[1]!.id); await expect(preview).toHaveCount(0);
      expect(await pair(page)).toEqual({ base: '2', target: '3', path: 'motion.md' });
      await privateTray(page).getByRole('button', { name: 'Preview complete review', exact: true }).click(); await expect(preview.locator('article')).toHaveCount(2);
      await preview.getByRole('button', { name: 'Publish private review', exact: true }).click(); await expect(privateTray(page).locator('.private-review-entry')).toHaveCount(0);
    }
    const result = await api<RevisionDetail>(page, `/revisions/${id}`); expect(result.comments).toHaveLength(privateSave ? 2 : 1);
    const originalComment = result.comments.find(item => item.body === `Exact ${privateSave ? 'private' : 'public'} comment on version one.`)!;
    exactAnchor(result, originalComment, 1, 'motion.md'); expect(originalComment.anchor!.quote).toBe(quote); expect(evidence(result)).toEqual(evidence(baseline));
    expect(await pair(page)).toEqual({ base: '2', target: '3', path: 'motion.md' });
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('view-only readers see exact inline discussion without comment or suggestion mutation controls', async ({ browser }, info) => {
  const alice = await signIn(browser, info), bob = await signIn(browser, info, 1);
  try {
    const detail = await fixture(alice.page, 'Read-only inline discussion'), id = detail.revision.id, original = detail.versions[0]!;
    const root = await api<ReviewComment>(alice.page, `/revisions/${id}/comments`, { body: 'An existing discussion on the removed original file.', versionId: original.id, filePath: 'removed.txt', passage: { start: 0, end: removedText.length, quote: removedText } });
    const state = await api<AppState>(alice.page, '/state'), policy = (await api<ObjectAccess>(alice.page, `/policies/${id}`)).policy;
    await api(alice.page, `/policies/${id}`, { expectedVersion: policy.version, spaceId: policy.spaceId, view: policy.rules.view, edit: { kind: 'principals', principalIds: [state.currentPrincipalId] }, interact: { kind: 'principals', principalIds: [state.currentPrincipalId] } }, 'PUT');
    const baseline = await api<RevisionDetail>(alice.page, `/revisions/${id}`);
    await bob.page.goto(`./#${id}`); await expect(bob.page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
    await bob.page.getByLabel('Source file', { exact: true }).selectOption('removed.txt');
    await expect(composer(bob.page)).toHaveCount(0); await expect(destination(bob.page)).toBeDisabled();
    const buttons = bob.page.getByRole('button', { name: /^Comment on (?:removed|added) text/ });
    for (const button of await buttons.all()) await expect(button).toBeDisabled();
    const inline = bob.page.locator(`[data-comparison-thread-id="${root.id}"]`); await expect(inline).toContainText(root.body);
    await inline.getByRole('button', { name: 'Open discussion', exact: true }).click(); await expect(bob.page.locator(`.review-thread[data-thread-id="${root.id}"]`)).toBeFocused();
    await expect(bob.page.getByRole('button', { name: 'Add Comment', exact: true })).toHaveCount(0); await expect(bob.page.getByRole('button', { name: 'Save Private Draft', exact: true })).toHaveCount(0);
    const result = await api<RevisionDetail>(alice.page, `/revisions/${id}`); expect(result.comments).toEqual(baseline.comments); expect(evidence(result)).toEqual(evidence(baseline));
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('Word projection comparisons retain their separate discussion controls and do not expose text-file source-side comments', async ({ page }) => {
  await page.goto('./#home'); const bytes = await readFile('tests/fixtures/docx/roundtrip.docx');
  const file = await api<FileRecord>(page, '/files', { name: 'inline-discussion-word.docx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }), state = await api<AppState>(page, '/state');
  const detail = await api<RevisionDetail>(page, '/revisions/docx', { title: 'Word inline discussion boundary', testPlan: 'Keep exact Word passage controls separate from text-file comparisons.', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, shareSource: false, expectedAccessEpoch: state.accessEpoch });
  await page.goto(`./#${detail.revision.id}`); await page.getByRole('button', { name: 'Compare Word Versions', exact: true }).click();
  await expect(page.getByLabel('Selected Word scope comparison', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Comment on (?:removed|added) text/ })).toHaveCount(0); await expect(destination(page)).toHaveCount(0);
  await expect(page.locator('[data-comparison-thread-id]')).toHaveCount(0);
  const result = await api<RevisionDetail>(page, `/revisions/${detail.revision.id}`); expect(result.comments).toEqual([]); expect(evidence(result)).toEqual(evidence(detail));
});
