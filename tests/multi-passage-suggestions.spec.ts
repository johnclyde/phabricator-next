import { test, expect, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { RevisionDetail, ReviewComment, SourceFile } from '../shared/types';
import type { ReviewDraftSnapshot } from '../shared/review-drafts';
import { reviewerApi as api } from './revision-reviewers-browser';

const mainText = '\\section{Argument}\r\nThe measured effect is small.\r\nRemove the redundant sentence.\r\nRetain Ω evidence.\r\n';
const appendixText = '\\section{Appendix}\r\nSource β 🧪 remains literal.\r\n';
const originalQuote = 'The measured effect is small.';
const removedQuote = 'Remove the redundant sentence.';
const appendixQuote = 'Source β 🧪 remains literal.';
const rootReplacement = 'The measured effect is substantial and precisely bounded.';
const appendixReplacement = 'Source γ 😀 <script>literal</script> remains literal.';
const explanation = 'Revise the finding, remove repetition, and clarify the appendix together.';
const files: SourceFile[] = [{ path: 'main.tex', content: mainText }, { path: 'appendix.tex', content: appendixText }, { path: 'references.bib', content: '% Unchanged companion source.\r\n' }];
const composer = (page: Page) => page.locator('.comment-form');
const tray = (page: Page) => page.getByRole('region', { name: 'Pending private review', exact: true });
const thread = (page: Page, id: string) => page.locator(`.review-thread[data-thread-id="${id}"]`);

async function create(page: Page, title: string) {
  await page.goto('./#home');
  const result = await api<RevisionDetail>(page, '/revisions', { title: `${title} ${randomUUID()}`, kind: 'paper', testPlan: 'Verify every exact passage and immutable source in one explicit multi-passage operation.', files });
  await page.goto(`./#${result.revision.id}`);
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
  await page.getByLabel('Source file', { exact: true }).selectOption('main.tex');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  return result;
}
async function openPrivate(page: Page) {
  const details = tray(page).locator(':scope > details');
  if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator(':scope > summary').click();
}
async function rootDraft(page: Page) {
  await page.getByLabel('Passage start line', { exact: true }).fill('2');
  await page.getByLabel('Passage end line', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Comment on line range', exact: true }).click();
  await composer(page).getByRole('checkbox', { name: 'Suggest an edit', exact: true }).check();
  await composer(page).getByLabel('Suggested replacement', { exact: true }).fill(rootReplacement);
  await composer(page).getByLabel('Review comment', { exact: true }).fill(explanation);
}
async function chooseExtra(page: Page, path: string, quote: string, nativeSelection = false) {
  await composer(page).getByRole('button', { name: 'Add another passage', exact: true }).click();
  await composer(page).getByLabel('Additional passage file', { exact: true }).selectOption(path);
  const source = files.find(file => file.path === path)!.content, start = source.indexOf(quote);
  expect(start).toBeGreaterThanOrEqual(0);
  const input = composer(page).getByLabel('Additional passage source', { exact: true });
  await expect(input).toHaveValue(source.replace(/\r\n?/g, '\n'));
  if (nativeSelection) {
    await input.evaluate((element, quote) => {
      const field = element as HTMLTextAreaElement, normalized = quote.replace(/\r\n?/g, '\n'), from = field.value.indexOf(normalized);
      if (from < 0) throw new Error('Exact passage is missing from the displayed source.');
      field.focus(); field.setSelectionRange(from, from + normalized.length);
      field.dispatchEvent(new Event('select', { bubbles: true })); field.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, quote);
  } else {
    await composer(page).getByText('Choose an exact character range', { exact: true }).click();
    await composer(page).getByLabel('Passage start offset', { exact: true }).fill(String(start));
    await composer(page).getByLabel('Passage end offset', { exact: true }).fill(String(start + quote.length));
  }
}
async function extra(page: Page, number: number, path: string, quote: string, replacement: string, reason: string) {
  await chooseExtra(page, path, quote, number === 3);
  await composer(page).getByRole('button', { name: 'Use selected passage', exact: true }).click();
  await expect(composer(page).getByRole('region', { name: `Suggested passage ${number}`, exact: true })).toContainText(quote);
  await composer(page).getByLabel(`Suggested replacement ${number}`, { exact: true }).fill(replacement);
  await composer(page).getByLabel(`Explanation for passage ${number}`, { exact: true }).fill(reason);
}
async function completeDraft(page: Page) {
  await rootDraft(page);
  await extra(page, 2, 'main.tex', removedQuote, '', 'This sentence repeats the finding.');
  await extra(page, 3, 'appendix.tex', appendixQuote, appendixReplacement, 'Keep the literal Unicode and markup in the source.');
}
async function publishDirect(page: Page, id: string) {
  await completeDraft(page);
  await composer(page).getByRole('button', { name: 'Add Suggested Edit', exact: true }).click();
  await expect(composer(page).getByLabel('Review comment', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: /^Discussion/ }).click();
  const detail = await api<RevisionDetail>(page, `/revisions/${id}`), root = detail.comments.find(comment => comment.body === explanation)!;
  expect(root).toBeTruthy(); await expect(thread(page, root.id)).toBeVisible();
  return root;
}
async function previewApply(page: Page, commentId: string) {
  await thread(page, commentId).getByRole('button', { name: 'Review Suggested Edit', exact: true }).click();
  const preview = thread(page, commentId).getByRole('region', { name: 'Confirm suggested edit', exact: true });
  await expect(preview).toContainText('3 passages');
  return preview;
}
async function exported(page: Page, scope: Locator) {
  const download = page.waitForEvent('download');
  await scope.getByRole('button', { name: 'Export private draft', exact: true }).click();
  const parts: Buffer[] = [];
  for await (const part of (await (await download).createReadStream())!) parts.push(Buffer.from(part));
  return JSON.parse(Buffer.concat(parts).toString()) as { payload: { suggestion: ReviewComment['suggestion'] } };
}
function expectedFiles(root = rootReplacement, appendix = appendixReplacement): SourceFile[] {
  return [{ path: 'main.tex', content: mainText.replace(originalQuote, root).replace(removedQuote, '') }, { path: 'appendix.tex', content: appendixText.replace(appendixQuote, appendix) }, files[2]!];
}

test('a complete private multi-file proposal previews every edit and applies once as one immutable version', async ({ page }, info) => {
  const created = await create(page, 'Complete multi-passage review'), id = created.revision.id;
  await completeDraft(page); await openPrivate(page);
  await composer(page).getByRole('button', { name: 'Save Private Draft', exact: true }).click();
  await expect(composer(page).getByLabel('Review comment', { exact: true })).toHaveValue('');
  const card = tray(page).locator('.private-review-entry'); await expect(card).toHaveCount(1);
  expect((await api<RevisionDetail>(page, `/revisions/${id}`)).comments).toEqual([]);
  const firstSaved = (await api<ReviewDraftSnapshot>(page, `/revisions/${id}/review-drafts`)).entries[0]!;
  expect(firstSaved.payload).toMatchObject({ suggestion: { replacement: rootReplacement, additionalEdits: [{ anchor: { filePath: 'main.tex', quote: removedQuote }, replacement: '', explanation: 'This sentence repeats the finding.' }, { anchor: { filePath: 'appendix.tex', quote: appendixQuote }, replacement: appendixReplacement }] } });
  await card.getByRole('button', { name: 'Edit private draft', exact: true }).click();
  const revisedRoot = `${rootReplacement} This remains bounded.`, revisedAppendix = `${appendixReplacement} Exact.`;
  await card.getByLabel('Private suggested replacement', { exact: true }).fill(revisedRoot);
  await card.getByLabel('Private suggested replacement 3', { exact: true }).fill(revisedAppendix);
  await card.getByLabel('Private explanation for passage 2', { exact: true }).fill('Delete only this redundant sentence, preserving both line breaks.');
  const recovery = await exported(page, card);
  expect(recovery.payload.suggestion).toMatchObject({ replacement: revisedRoot, additionalEdits: [{ replacement: '', explanation: 'Delete only this redundant sentence, preserving both line breaks.' }, { replacement: revisedAppendix }] });
  await card.getByRole('button', { name: 'Save private entry', exact: true }).click();
  await expect(card.getByLabel('Private suggested replacement', { exact: true })).toHaveCount(0);
  await tray(page).getByRole('button', { name: 'Preview complete review', exact: true }).click();
  const preview = tray(page).getByRole('region', { name: 'Complete private review preview', exact: true });
  await expect(preview.locator('.suggestion-original')).toHaveText([originalQuote, removedQuote, appendixQuote]);
  await expect(preview.locator('.suggestion-replacement')).toHaveText([revisedRoot, revisedAppendix]);
  await expect(preview).toContainText('Delete only this redundant sentence, preserving both line breaks.');
  await expect(preview).toContainText('appendix.tex'); expect(await preview.locator('script').count()).toBe(0);
  await preview.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (info.project.name === 'mobile') expect((await preview.getByRole('button', { name: 'Publish private review', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await preview.screenshot({ path: info.outputPath('complete-private-multi-passage-preview.png') });
  await preview.getByRole('button', { name: 'Publish private review', exact: true }).click();
  await expect(tray(page).locator('.private-review-entry')).toHaveCount(0);
  const published = await api<RevisionDetail>(page, `/revisions/${id}`); expect(published.versions).toEqual(created.versions); expect(published.comments).toHaveLength(1);
  const proposal = published.comments[0]!; expect(proposal.suggestion).toEqual(recovery.payload.suggestion);
  await page.getByRole('button', { name: /^Discussion/ }).click();
  await expect(thread(page, proposal.id).locator('.suggestion-original')).toHaveText([originalQuote, removedQuote, appendixQuote]);
  const application = await previewApply(page, proposal.id);
  await application.getByRole('button', { name: 'Apply as New Version', exact: true }).click();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
  const applied = await api<RevisionDetail>(page, `/revisions/${id}`);
  expect(applied.versions).toHaveLength(2); expect(applied.versions[0]).toEqual(created.versions[0]); expect(applied.versions[1]!.files).toEqual(expectedFiles(revisedRoot, revisedAppendix));
  expect(applied.comments).toEqual(published.comments); expect(applied.suggestionApplications).toHaveLength(1); expect(applied.threads[0]).toMatchObject({ version: 2, status: 'open' });
  await expect(thread(page, proposal.id).getByRole('button', { name: 'Review Suggested Edit', exact: true })).toHaveCount(0);
  await page.reload(); await expect(thread(page, proposal.id).locator('.suggestion-application')).toContainText('version 2');
});

test('a concurrent reply or new source rejects the whole multi-passage proposal without partial changes', async ({ page }) => {
  const created = await create(page, 'Stale multi-passage review'), id = created.revision.id, original = created.versions[0]!;
  const proposal = await publishDirect(page, id);
  let preview = await previewApply(page, proposal.id);
  await api(page, `/revisions/${id}/threads/${proposal.id}/replies`, { body: 'Wait for this newly raised concern.', viewedVersionId: original.id });
  await preview.getByRole('button', { name: 'Apply as New Version', exact: true }).click();
  await expect(thread(page, proposal.id).getByRole('alert')).toContainText('discussion changed');
  await expect(thread(page, proposal.id)).toContainText('Wait for this newly raised concern.');
  const afterReply = await api<RevisionDetail>(page, `/revisions/${id}`); expect(afterReply.versions).toEqual(created.versions); expect(afterReply.suggestionApplications).toEqual([]);
  preview = await previewApply(page, proposal.id);
  const currentFiles = files.map(file => ({ ...file, content: file.path === 'references.bib' ? '% A separate source change.\r\n' : file.content }));
  const newer = await api<RevisionDetail>(page, `/revisions/${id}/versions`, { expectedVersion: 1, message: 'Change the companion file after preview', files: currentFiles });
  await preview.getByRole('button', { name: 'Apply as New Version', exact: true }).click();
  await expect(thread(page, proposal.id).getByRole('button', { name: 'Review Suggested Edit', exact: true })).toBeDisabled();
  await expect(thread(page, proposal.id)).toContainText('Create a new suggestion on the current version');
  const afterSource = await api<RevisionDetail>(page, `/revisions/${id}`); expect(afterSource.versions).toEqual(newer.versions); expect(afterSource.suggestionApplications).toEqual([]);
  await expect(thread(page, proposal.id).locator('.suggestion-original')).toHaveText([originalQuote, removedQuote, appendixQuote]);
});

test('a lost multi-passage application response recovers the one recorded application without repeating edits', async ({ page }) => {
  const created = await create(page, 'Multi-passage application recovery'), id = created.revision.id;
  const proposal = await publishDirect(page, id), preview = await previewApply(page, proposal.id);
  let writes = 0;
  await page.route(`**/api/revisions/${id}/suggestions/${proposal.id}/apply`, async route => { writes++; const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort('failed'); });
  await preview.getByRole('button', { name: 'Apply as New Version', exact: true }).click();
  await expect(thread(page, proposal.id).locator('.suggestion-application')).toContainText('version 2');
  await expect(thread(page, proposal.id).getByRole('button', { name: 'Review Suggested Edit', exact: true })).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' }); await page.reload();
  await expect(thread(page, proposal.id).locator('.suggestion-application')).toContainText('version 2'); expect(writes).toBe(1);
  const result = await api<RevisionDetail>(page, `/revisions/${id}`); expect(result.versions).toHaveLength(2); expect(result.versions[0]).toEqual(created.versions[0]); expect(result.versions[1]!.files).toEqual(expectedFiles()); expect(result.suggestionApplications).toHaveLength(1);
});

test('multi-passage drafts reject overlap and retain unfinished exact edits across offline reloads', async ({ page, context }, info) => {
  const created = await create(page, 'Retained multi-passage draft'), id = created.revision.id, version = created.versions[0]!;
  await rootDraft(page); await chooseExtra(page, 'main.tex', originalQuote);
  const use = composer(page).getByRole('button', { name: 'Use selected passage', exact: true });
  if (await use.isEnabled()) await use.click();
  await expect(composer(page).getByLabel('Suggested replacement 2', { exact: true })).toHaveCount(0);
  await expect(composer(page)).toContainText(/overlap/i);
  // Cancel the picker, then create two exact edits at disjoint original offsets.
  await composer(page).getByRole('button', { name: 'Cancel passage selection', exact: true }).click();
  await extra(page, 2, 'main.tex', removedQuote, '', '');
  await extra(page, 3, 'appendix.tex', appendixQuote, appendixReplacement, 'Keep the second file exact.');
  await composer(page).getByLabel('Suggested replacement', { exact: true }).fill(`${rootReplacement} Later root draft.`);
  await expect(composer(page).getByRole('button', { name: 'Add Suggested Edit', exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(key => { const stored = Object.keys(localStorage).find(item => item.endsWith(`:${key}`)); return stored ? JSON.parse(localStorage.getItem(stored)!).suggestion : null; }, `comment-source:${id}:${version.id}`)).toMatchObject({ replacement: `${rootReplacement} Later root draft.`, additionalEdits: [{ replacement: '', explanation: '' }, { replacement: appendixReplacement }] });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  let writes = 0; page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.includes(`/revisions/${id}/`)) writes++; });
  await context.setOffline(true);
  try {
    await page.reload(); await expect(composer(page).getByLabel('Suggested replacement', { exact: true })).toHaveValue(`${rootReplacement} Later root draft.`);
    await expect(composer(page).getByLabel('Suggested replacement 2', { exact: true })).toHaveValue('');
    await expect(composer(page).getByLabel('Explanation for passage 2', { exact: true })).toHaveValue('');
    await expect(composer(page).getByLabel('Suggested replacement 3', { exact: true })).toHaveValue(appendixReplacement);
    await expect(composer(page).getByRole('region', { name: 'Suggested passage 2', exact: true })).toContainText(removedQuote);
    await expect(composer(page).getByRole('region', { name: 'Suggested passage 3', exact: true })).toContainText(appendixQuote);
    await expect(composer(page).getByRole('button', { name: 'Add Suggested Edit', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await composer(page).screenshot({ path: info.outputPath('offline-multi-passage-draft.png') });
  } finally { await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); }
  expect(writes).toBe(0); const current = await api<RevisionDetail>(page, `/revisions/${id}`); expect(current.versions).toEqual(created.versions); expect(current.comments).toEqual([]);
});
