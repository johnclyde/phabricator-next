import { test, expect, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createPassageAnchor } from '../shared/anchors';
import type { ReviewDraftSnapshot } from '../shared/review-drafts';
import type { RevisionDetail, RevisionVersion, ReviewComment, SourceFile, SuggestedReplacement } from '../shared/types';
import { reviewerApi as api, reviewerBase } from './revision-reviewers-browser';

const COUNT = 41;
const quote = (number: number) => `Original passage ${String(number).padStart(3, '0')} Ω 🧪.`;
const replacement = (number: number) => number % 7 === 0 ? '' : `Revised passage ${String(number).padStart(3, '0')} β 😀.`;
const explanation = (number: number) => `Explain exact change ${number}, preserving every other passage.`;
const pathFor = (number: number) => number <= 21 ? 'main.tex' : 'appendix.tex';
const files: SourceFile[] = [
  { path: 'main.tex', content: Array.from({ length: 21 }, (_, index) => quote(index + 1)).join('\r\n') + '\r\n' },
  { path: 'appendix.tex', content: Array.from({ length: 20 }, (_, index) => quote(index + 22)).join('\r\n') + '\r\n' },
  { path: 'references.bib', content: '% This companion stays byte-for-byte unchanged.\r\n' },
];
const composer = (page: Page) => page.locator('.comment-form');
const tray = (page: Page) => page.getByRole('region', { name: 'Pending private review', exact: true });
const thread = (page: Page, id: string) => page.locator(`.review-thread[data-thread-id="${id}"]`);
const passagesNav = (scope: Locator, name: string) => scope.getByRole('navigation', { name, exact: true });

async function create(page: Page, title: string) {
  await page.goto('./#home');
  const created = await api<RevisionDetail>(page, '/revisions', { title: `${title} ${randomUUID()}`, kind: 'paper', testPlan: 'Check a complete proposal larger than the old passage limit without changing existing workspace data.', files });
  await page.goto(`./#${created.revision.id}`);
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
  await page.getByLabel('Source file', { exact: true }).selectOption('main.tex');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  return created;
}
function proposal(version: RevisionVersion, count = COUNT): SuggestedReplacement {
  return { replacement: replacement(1), additionalEdits: Array.from({ length: count - 1 }, (_, index) => {
    const number = index + 2, path = pathFor(number), source = version.files.find(file => file.path === path)!.content, start = source.indexOf(quote(number));
    return { anchor: createPassageAnchor(version, path, { start, end: start + quote(number).length, quote: quote(number) }), replacement: replacement(number), explanation: explanation(number) };
  }) };
}
function commentInput(version: RevisionVersion, suggestion = proposal(version)) {
  return { body: explanation(1), versionId: version.id, filePath: 'main.tex', passage: { start: 0, end: quote(1).length, quote: quote(1) }, suggestion };
}
async function choose(page: Page, number: number) {
  const form = composer(page), path = pathFor(number), source = files.find(file => file.path === path)!.content, start = source.indexOf(quote(number));
  await form.getByRole('button', { name: 'Add another passage', exact: true }).click();
  await form.getByLabel('Additional passage file', { exact: true }).selectOption(path);
  await form.getByText('Choose an exact character range', { exact: true }).click();
  await form.getByLabel('Passage start offset', { exact: true }).fill(String(start));
  await form.getByLabel('Passage end offset', { exact: true }).fill(String(start + quote(number).length));
}
async function author(page: Page, count = COUNT) {
  await page.getByLabel('Passage start line', { exact: true }).fill('1');
  await page.getByLabel('Passage end line', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Comment on line range', exact: true }).click();
  await composer(page).getByRole('checkbox', { name: 'Suggest an edit', exact: true }).check();
  await composer(page).getByLabel('Suggested replacement', { exact: true }).fill(replacement(1));
  await composer(page).getByLabel('Review comment', { exact: true }).fill(explanation(1));
  for (let number = 2; number <= count; number++) {
    await choose(page, number);
    await composer(page).getByRole('button', { name: 'Use selected passage', exact: true }).click();
    await composer(page).getByLabel(`Suggested replacement ${number}`, { exact: true }).fill(replacement(number));
    await composer(page).getByLabel(`Explanation for passage ${number}`, { exact: true }).fill(explanation(number));
  }
  await expect(composer(page).getByRole('button', { name: 'Add another passage', exact: true })).toBeEnabled();
}
async function openPrivate(page: Page) {
  const details = tray(page).locator(':scope > details');
  if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator(':scope > summary').click();
}
async function firstPage(nav: Locator) {
  if (await nav.count() && await nav.getByRole('button', { name: 'First passages', exact: true }).isEnabled()) await nav.getByRole('button', { name: 'First passages', exact: true }).click();
}
async function checkPreview(scope: Locator, count = COUNT, revisedLast = replacement(COUNT)) {
  const nav = passagesNav(scope, 'Suggested edit preview pages'), originals = scope.locator('.suggestion-original');
  // The private preview is an asynchronous read. Wait for its content before
  // inspecting page controls; an immediate count can observe the loading gap.
  await expect(originals.first()).toBeVisible();
  if (count > 10) { await expect(nav).toBeVisible(); await firstPage(nav); }
  const expected = Array.from({ length: count }, (_, index) => quote(index + 1)), seen: string[] = [];
  for (let start = 0; start < count; start += 10) {
    await expect(originals).toHaveText(expected.slice(start, start + 10));
    seen.push(...await originals.allTextContents());
    if (start + 10 < count) await nav.getByRole('button', { name: 'Next passages', exact: true }).click();
  }
  expect(seen).toEqual(expected);
  if (count > 10) await expect(nav.getByRole('button', { name: 'Next passages', exact: true })).toBeDisabled();
  await expect(scope.locator('.suggestion-replacement').last()).toHaveText(revisedLast);
}
async function exported(page: Page, scope: Locator): Promise<{ payload: { suggestion: SuggestedReplacement } }> {
  const download = page.waitForEvent('download');
  await scope.getByRole('button', { name: 'Export private draft', exact: true }).click();
  const chunks: Buffer[] = []; for await (const chunk of (await (await download).createReadStream())!) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function review(page: Page, commentId: string) {
  await thread(page, commentId).getByRole('button', { name: 'Review Suggested Edit', exact: true }).click();
  const preview = thread(page, commentId).getByRole('region', { name: 'Confirm suggested edit', exact: true });
  await expect(preview).toContainText(`${COUNT} passages`); return preview;
}
function expectedFiles(last = replacement(COUNT)) {
  return files.map(file => ({ ...file, content: Array.from({ length: COUNT }, (_, index) => index + 1).reduce((content, number) => pathFor(number) === file.path ? content.replace(quote(number), number === COUNT ? last : replacement(number)) : content, file.content) }));
}

test('forty-one UI-authored passages stay complete through private editing, export, paged previews and one atomic application', async ({ page, context }, info) => {
  test.setTimeout(180_000);
  const created = await create(page, 'Proposal beyond twenty passages'), id = created.revision.id;
  await author(page);
  const authorNav = passagesNav(composer(page), 'Additional suggested passage pages');
  await firstPage(authorNav); await expect(composer(page).getByLabel('Suggested replacement 2', { exact: true })).toHaveValue(replacement(2));
  await authorNav.getByRole('button', { name: 'Last passages', exact: true }).click();
  await expect(composer(page).getByLabel(`Suggested replacement ${COUNT}`, { exact: true })).toHaveValue(replacement(COUNT));
  await openPrivate(page); await composer(page).getByRole('button', { name: 'Save Private Draft', exact: true }).click();
  await expect(composer(page).getByLabel('Review comment', { exact: true })).toHaveValue('');
  const card = tray(page).locator('.private-review-entry'); await expect(card).toHaveCount(1);
  const saved = (await api<ReviewDraftSnapshot>(page, `/revisions/${id}/review-drafts`)).entries[0]!;
  expect(saved.payload).toMatchObject({ suggestion: proposal(created.versions[0]!) });
  expect((await api<RevisionDetail>(page, `/revisions/${id}`)).comments).toEqual([]);
  await card.getByRole('button', { name: 'Edit private draft', exact: true }).click();
  const editorNav = passagesNav(card, 'Private suggested passage pages');
  const revisedLast = `${replacement(COUNT)} Revised offline in the last private page.`;
  await context.setOffline(true);
  const recovery = await (async () => {
    try {
      await expect(card.getByRole('button', { name: 'Save private entry', exact: true })).toBeDisabled();
      await editorNav.getByLabel('Passage page', { exact: true }).fill('4');
      await editorNav.getByRole('button', { name: 'Go to page', exact: true }).click();
      await card.getByLabel(`Private suggested replacement ${COUNT}`, { exact: true }).fill(revisedLast);
      return await exported(page, card);
    } finally { await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); }
  })();
  expect(recovery.payload.suggestion.additionalEdits).toHaveLength(COUNT - 1);
  expect(recovery.payload.suggestion).toEqual({ ...proposal(created.versions[0]!), additionalEdits: proposal(created.versions[0]!).additionalEdits!.map((edit, index) => index === COUNT - 2 ? { ...edit, replacement: revisedLast } : edit) });
  await expect(card.getByRole('button', { name: 'Save private entry', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: 'Save private entry', exact: true }).click();
  await expect(card.getByLabel('Private suggested replacement', { exact: true })).toHaveCount(0);
  await tray(page).getByRole('button', { name: 'Preview complete review', exact: true }).click();
  const publication = tray(page).getByRole('region', { name: 'Complete private review preview', exact: true });
  await checkPreview(publication, COUNT, revisedLast);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (info.project.name === 'mobile') expect((await passagesNav(publication, 'Suggested edit preview pages').getByRole('button', { name: 'Previous passages', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await publication.screenshot({ path: info.outputPath('last-page-complete-proposal.png') });
  await publication.getByRole('button', { name: 'Publish private review', exact: true }).click();
  await expect(tray(page).locator('.private-review-entry')).toHaveCount(0);
  const published = await api<RevisionDetail>(page, `/revisions/${id}`);
  expect(published.versions).toEqual(created.versions); expect(published.comments).toHaveLength(1);
  const root = published.comments[0]!; expect(root.suggestion).toEqual(recovery.payload.suggestion);
  await page.getByRole('button', { name: /^Discussion/ }).click(); await checkPreview(thread(page, root.id), COUNT, revisedLast);
  const application = await review(page, root.id); await checkPreview(thread(page, root.id), COUNT, revisedLast);
  await application.getByRole('button', { name: 'Apply as New Version', exact: true }).click();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2');
  const applied = await api<RevisionDetail>(page, `/revisions/${id}`);
  expect(applied.versions).toHaveLength(2); expect(applied.versions[0]).toEqual(created.versions[0]); expect(applied.versions[1]!.files).toEqual(expectedFiles(revisedLast));
  expect(applied.comments).toEqual(published.comments); expect(applied.suggestionApplications).toHaveLength(1);
  await page.reload(); await expect(thread(page, root.id).locator('.suggestion-application')).toContainText('version 2');
});

test('the last of forty-one edits cannot overlap or carry stale context, and changed discussion or source rejects the complete application', async ({ page }) => {
  test.setTimeout(70_000);
  const created = await create(page, 'Complete large proposal rejection'), id = created.revision.id, version = created.versions[0]!, valid = proposal(version);
  const first = createPassageAnchor(version, 'main.tex', { start: 0, end: quote(1).length, quote: quote(1) });
  for (const anchor of [first, { ...valid.additionalEdits!.at(-1)!.anchor, prefix: 'Invalid original context' }]) {
    const invalid = { ...valid, additionalEdits: valid.additionalEdits!.map((edit, index) => index === COUNT - 2 ? { ...edit, anchor } : edit) };
    const status = await page.evaluate(async ({ base, id, body }) => {
      const session = await (await fetch(`${base}api/session`)).json();
      const response = await fetch(`${base}api/revisions/${id}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Context': session.sessionContext, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });
      return response.status;
    }, { base: reviewerBase, id, body: commentInput(version, invalid) });
    expect(status).toBe(400);
    const unchanged = await api<RevisionDetail>(page, `/revisions/${id}`); expect(unchanged.versions).toEqual(created.versions); expect(unchanged.comments).toEqual([]); expect(unchanged.suggestionApplications).toEqual([]);
  }
  const root = await api<ReviewComment>(page, `/revisions/${id}/comments`, commentInput(version));
  await page.reload(); await page.getByRole('button', { name: /^Discussion/ }).click();
  let preview = await review(page, root.id);
  await api(page, `/revisions/${id}/threads/${root.id}/replies`, { body: 'A new discussion must be seen before applying any passage.', viewedVersionId: version.id });
  await preview.getByRole('button', { name: 'Apply as New Version', exact: true }).click();
  await expect(thread(page, root.id).getByRole('alert')).toContainText('discussion changed');
  const afterReply = await api<RevisionDetail>(page, `/revisions/${id}`); expect(afterReply.versions).toEqual(created.versions); expect(afterReply.suggestionApplications).toEqual([]);
  preview = await review(page, root.id);
  const newer = await api<RevisionDetail>(page, `/revisions/${id}/versions`, { expectedVersion: 1, message: 'Change only the final passage after the complete preview', files: files.map(file => ({ ...file, content: file.content.replace(quote(COUNT), 'A separate change to the final passage.') })) });
  await preview.getByRole('button', { name: 'Apply as New Version', exact: true }).click();
  await expect(thread(page, root.id).getByRole('button', { name: 'Review Suggested Edit', exact: true })).toBeDisabled();
  await expect(thread(page, root.id)).toContainText('Create a new suggestion on the current version');
  const afterSource = await api<RevisionDetail>(page, `/revisions/${id}`); expect(afterSource.versions).toEqual(newer.versions); expect(afterSource.suggestionApplications).toEqual([]); expect(afterSource.comments.find(comment => comment.id === root.id)!.suggestion!.additionalEdits).toHaveLength(COUNT - 1);
  await checkPreview(thread(page, root.id));
});

test('a proposal beyond twenty passages retains every unfinished edit through offline reload and page changes', async ({ page, context }, info) => {
  test.setTimeout(120_000);
  const count = 21, created = await create(page, 'Retained large proposal'), id = created.revision.id, version = created.versions[0]!;
  await author(page, count);
  await composer(page).getByLabel(`Explanation for passage ${count}`, { exact: true }).fill('');
  await choose(page, 1);
  await expect(composer(page).getByRole('button', { name: 'Use selected passage', exact: true })).toBeDisabled();
  await expect(composer(page)).toContainText(/overlap/i);
  await composer(page).getByRole('button', { name: 'Cancel passage selection', exact: true }).click();
  const draftKey = `comment-source:${id}:${version.id}`;
  const retained = () => page.evaluate(key => { const stored = Object.keys(localStorage).find(item => item.endsWith(`:${key}`)); return stored ? JSON.parse(localStorage.getItem(stored)!).suggestion : null; }, draftKey);
  const expected = { ...proposal(version, count), additionalEdits: proposal(version, count).additionalEdits!.map((edit, index) => index === count - 2 ? { ...edit, explanation: '' } : edit) };
  await expect.poll(retained).toEqual(expected);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  let writes = 0; page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.includes(`/revisions/${id}/`)) writes++; });
  await context.setOffline(true);
  try {
    await page.reload(); await expect(composer(page).getByLabel('Suggested replacement', { exact: true })).toHaveValue(replacement(1));
    const nav = passagesNav(composer(page), 'Additional suggested passage pages'); await firstPage(nav);
    const seen: number[] = [];
    for (let number = 2; number <= count; number++) {
      if (number === 12) await nav.getByRole('button', { name: 'Next passages', exact: true }).click();
      await expect(composer(page).getByLabel(`Suggested replacement ${number}`, { exact: true })).toHaveValue(replacement(number));
      await expect(composer(page).getByLabel(`Explanation for passage ${number}`, { exact: true })).toHaveValue(number === count ? '' : explanation(number));
      seen.push(number);
    }
    expect(seen).toHaveLength(count - 1); expect(await retained()).toEqual(expected);
    await expect(composer(page).getByRole('button', { name: 'Add Suggested Edit', exact: true })).toBeDisabled();
    await expect(composer(page).getByRole('button', { name: 'Add another passage', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await composer(page).screenshot({ path: info.outputPath('offline-proposal-last-page.png') });
  } finally { await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); }
  expect(writes).toBe(0); const unchanged = await api<RevisionDetail>(page, `/revisions/${id}`); expect(unchanged.versions).toEqual(created.versions); expect(unchanged.comments).toEqual([]);
});
