import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { RevisionDetail, ReviewComment, SourceFile } from '../shared/types';
import { openComparisonOptions } from './comparison-ui';

const manuscript = (claim: string) => [
  '\\documentclass{article}', '\\usepackage{amsmath}', '\\title{Two versions of a paper}', '\\author{An Author}',
  '\\begin{document}', '\\maketitle', '\\section{The argument}', claim, '\\end{document}', '',
].join('\r\n');
const versions = [
  manuscript('The first claim is $a+b=c$.'),
  manuscript('The earlier claim is $a^2+b^2=c^2$. Unicode evidence: β 😀.'),
  manuscript('The corrected claim is $a^2+b^2\\neq c^2$. Unicode evidence: β 😀.'),
];
const removed = 'A removed appendix: β 😀.\r\nIts last line has no final newline.';
const added = 'A new appendix: γ 😀.\r\nIts last line has no final newline.';
const panel = (page: Page) => page.locator('.revision-comparison-panel');
const choose = (page: Page, name: string) => panel(page).getByRole('button', { name, exact: true }).click();
const sourceSplit = (page: Page) => panel(page).locator('.comparison-split');
const renderedSplit = (page: Page) => panel(page).locator('.paper-preview-split');
const renderedSide = (page: Page, side: 'before' | 'after') => renderedSplit(page).locator(`[data-comparison-side="${side}"]`);
const renderedChanges = (page: Page, side: 'before' | 'after') => renderedSide(page, side).locator('.paper-preview-change');
const comment = (page: Page) => page.getByLabel('Review comment', { exact: true });
const composer = (page: Page) => page.locator('.comment-form');

async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> {
  const response = await request.fetch(new URL(`api${path}`, baseURL).href, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { data: body, headers: { 'Idempotency-Key': randomUUID() } }),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}
async function create(request: APIRequestContext, baseURL: string, sourceVersions: string[] = versions) {
  const files = (number: number): SourceFile[] => [
    { path: 'main.tex', content: sourceVersions[number - 1]! }, { path: 'empty.tex', content: '' },
    ...(number === 2 ? [{ path: 'removed.tex', content: removed }] : []),
    ...(number === 3 ? [{ path: 'added.tex', content: added }] : []),
  ];
  const created = await api<RevisionDetail>(request, baseURL, '/revisions', {
    kind: 'paper', title: `Side by side paper ${randomUUID()}`, summary: 'Review two immutable manuscript versions.',
    testPlan: 'Retain exact source, comments, comparison selection and offline drafts across both layouts.', files: files(1),
  });
  for (const number of [2, 3]) await api(request, baseURL, `/revisions/${created.revision.id}/versions`, {
    expectedVersion: number - 1, message: `Manuscript version ${number}`, files: files(number),
  });
  return api<RevisionDetail>(request, baseURL, `/revisions/${created.revision.id}`);
}
async function exactSide(page: Page, side: 'before' | 'after') {
  return sourceSplit(page).locator(`.comparison-split-code[data-comparison-side="${side}"]`).evaluateAll(nodes => nodes.map(node => node.textContent).join(''));
}
async function pair(page: Page) {
  return {
    base: await page.getByLabel('Base version', { exact: true }).inputValue(),
    target: await page.getByLabel('Version to inspect', { exact: true }).inputValue(),
    path: await page.getByLabel('Source file', { exact: true }).inputValue(),
  };
}
async function contained(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function highlightedClaim(page: Page, side: 'before' | 'after', claim: 'earlier' | 'corrected') {
  const kind = side === 'before' ? 'removed' : 'added', pane = renderedSide(page, side);
  await expect(pane.locator(`.paper-preview-change[data-change-kind="${kind}"] .katex annotation`)).toHaveText(claim === 'earlier' ? 'a^2+b^2=c^2' : 'a^2+b^2\\neq c^2');
  const marked = (await renderedChanges(page, side).allTextContents()).join('');
  expect(marked).toContain(claim);
  expect(marked).not.toContain('Unicode evidence'); expect(marked).not.toContain('β'); expect(marked).not.toContain('😀');
  await expect(pane.getByRole('heading', { name: 'Two versions of a paper', exact: true }).locator('.paper-preview-change')).toHaveCount(0);
  await expect(pane.locator(`.paper-preview-change[data-change-kind="${kind === 'removed' ? 'added' : 'removed'}"]`)).toHaveCount(0);
}
function exactComment(detail: RevisionDetail, saved: ReviewComment, versionNumber: number, expected: string) {
  const version = detail.versions.find(item => item.number === versionNumber)!;
  expect(saved).toMatchObject({ versionId: version.id, filePath: 'main.tex', line: 8 });
  expect(saved.anchor).toMatchObject({ versionId: version.id, contentHash: version.contentHash, filePath: 'main.tex', quote: expected });
  expect(version.files[0]!.content.slice(saved.anchor!.start, saved.anchor!.end)).toBe(expected);
}

test('the latest two paper versions have exact source and rendered side by side views with a remembered layout', async ({ page, request, baseURL }, info) => {
  const detail = await create(request, baseURL!);
  await page.goto(`./#${detail.revision.id}`);
  expect(await pair(page)).toEqual({ base: '2', target: '3', path: 'main.tex' });
  await expect(panel(page).getByRole('button', { name: 'Changes', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await choose(page, 'Side by side');
  await expect(sourceSplit(page)).toBeVisible();
  expect(await exactSide(page, 'before')).toBe(versions[1]);
  expect(await exactSide(page, 'after')).toBe(versions[2]);
  await expect(panel(page).locator('.literal-diff')).toHaveCount(0);
  await contained(page);
  await panel(page).screenshot({ path: info.outputPath('paper-source-side-by-side.png') });

  await choose(page, 'Preview');
  const before = renderedSide(page, 'before'), after = renderedSide(page, 'after');
  await expect(before.getByRole('region', { name: 'Paper reading preview', exact: true })).toBeVisible();
  await expect(after.getByRole('region', { name: 'Paper reading preview', exact: true })).toBeVisible();
  await expect(before).toContainText('The earlier claim'); await expect(before).not.toContainText('The corrected claim');
  await expect(after).toContainText('The corrected claim'); await expect(after).not.toContainText('The earlier claim');
  for (const side of [before, after]) {
    await expect(side.getByRole('heading', { name: 'Two versions of a paper', exact: true })).toBeVisible();
    await expect(side.locator('.katex')).toHaveCount(1);
    await expect(side).not.toContainText('\\begin{document}'); await expect(side).not.toContainText('\\end{document}');
  }
  await expect(panel(page).getByText('Removed from base', { exact: true })).toBeVisible();
  await expect(panel(page).getByText('Added in target', { exact: true })).toBeVisible();
  await highlightedClaim(page, 'before', 'earlier'); await highlightedClaim(page, 'after', 'corrected');
  await expect(panel(page).locator('.literal-diff, .passage-navigation')).toHaveCount(0);
  const left = (await before.boundingBox())!, right = (await after.boundingBox())!;
  expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
  if (info.project.name === 'mobile') {
    expect(left.width).toBeGreaterThanOrEqual(260); expect(right.width).toBeGreaterThanOrEqual(260);
    const scroll = panel(page).locator('.paper-preview-split-scroll');
    expect(await scroll.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    await scroll.evaluate(node => { node.scrollLeft = node.scrollWidth; });
    expect(await scroll.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    const viewport = (await scroll.boundingBox())!, target = (await after.boundingBox())!;
    expect(target.x).toBeLessThan(viewport.x + viewport.width);
    expect(target.x + target.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1);
    await contained(page);
    await scroll.evaluate(node => { node.scrollLeft = 0; });
  }
  await contained(page);
  await panel(page).screenshot({ path: info.outputPath('paper-rendered-side-by-side.png') });
  await page.reload();
  await expect(panel(page).getByRole('button', { name: 'Side by side', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(renderedSide(page, 'before')).toContainText('The earlier claim');
  await expect(renderedSide(page, 'after')).toContainText('The corrected claim');
  await highlightedClaim(page, 'before', 'earlier'); await highlightedClaim(page, 'after', 'corrected');
  expect(await pair(page)).toEqual({ base: '2', target: '3', path: 'main.tex' });
  const download = page.waitForEvent('download');
  await panel(page).getByRole('button', { name: 'Download source', exact: true }).click();
  expect(await readFile((await (await download).path())!, 'utf8')).toBe(versions[2]);
  await choose(page, 'Changes'); await expect(sourceSplit(page)).toBeVisible();
  await openComparisonOptions(page); await page.getByLabel('Comparison mode', { exact: true }).selectOption('lines');
  expect(await exactSide(page, 'before')).toBe(versions[1]); expect(await exactSide(page, 'after')).toBe(versions[2]);
  await page.getByLabel('Comparison mode', { exact: true }).selectOption('words');
  await choose(page, 'Inline'); await expect(panel(page).locator('.literal-diff')).toBeVisible();
  await expect(sourceSplit(page)).toHaveCount(0);
  expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${detail.revision.id}`)).versions).toEqual(detail.versions);
});

test('reversed and identical paper pairs keep both source panes and line comments on their immutable versions', async ({ page, request, baseURL }, info) => {
  const detail = await create(request, baseURL!);
  await page.goto(`./#${detail.revision.id}`); await choose(page, 'Side by side');
  await openComparisonOptions(page); await panel(page).getByRole('button', { name: 'Swap versions', exact: true }).click();
  expect(await pair(page)).toEqual({ base: '3', target: '2', path: 'main.tex' });
  expect(await exactSide(page, 'before')).toBe(versions[2]); expect(await exactSide(page, 'after')).toBe(versions[1]);
  for (const [label, number] of [['Comment on base line 8 · Version 3', 3], ['Comment on line 8', 2]] as const) {
    const button = sourceSplit(page).getByRole('button', { name: label, exact: true });
    await expect(button).toBeEnabled();
    if (info.project.name === 'mobile') {
      const bounds = (await button.boundingBox())!;
      expect(bounds.height).toBeGreaterThanOrEqual(44); expect(bounds.width).toBeGreaterThanOrEqual(44);
    }
    await button.click();
    const expected = versions[number - 1]!.split('\r\n')[7]!;
    await expect(composer(page).locator('.thread-quotation')).toHaveText(expected);
    await expect(page.getByLabel('Comment version', { exact: true })).toHaveValue(detail.versions.find(item => item.number === number)!.id);
    await comment(page).fill(`Review version ${number} from the reversed split.`);
    await composer(page).getByRole('button', { name: 'Add Comment', exact: true }).click();
    await expect(comment(page)).toHaveValue('');
    const saved = await api<RevisionDetail>(request, baseURL!, `/revisions/${detail.revision.id}`);
    exactComment(saved, saved.comments.find(item => item.body === `Review version ${number} from the reversed split.`)!, number, expected);
  }
  expect(await pair(page)).toEqual({ base: '3', target: '2', path: 'main.tex' });
  await choose(page, 'Preview');
  await expect(renderedSide(page, 'before')).toContainText('The corrected claim');
  await expect(renderedSide(page, 'after')).toContainText('The earlier claim');
  await highlightedClaim(page, 'before', 'corrected'); await highlightedClaim(page, 'after', 'earlier');
  await page.getByLabel('Base version', { exact: true }).selectOption('2');
  for (const side of ['before', 'after'] as const) await expect(renderedSide(page, side)).toContainText('The earlier claim');
  await expect(renderedSplit(page).locator('.paper-preview-change')).toHaveCount(0);
  for (const side of ['before', 'after'] as const) await expect(renderedSide(page, side).locator('.katex annotation')).toHaveText('a^2+b^2=c^2');
  await choose(page, 'Changes');
  for (const side of ['before', 'after'] as const) expect(await exactSide(page, side)).toBe(versions[1]);
  await expect(panel(page).locator('.passage-navigation')).toContainText('No text changes');
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('3');
  expect(await pair(page)).toEqual({ base: '2', target: '3', path: 'main.tex' });
  await expect(panel(page).getByRole('button', { name: 'Side by side', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await exactSide(page, 'before')).toBe(versions[1]); expect(await exactSide(page, 'after')).toBe(versions[2]);
  await contained(page);
  const after = await api<RevisionDetail>(request, baseURL!, `/revisions/${detail.revision.id}`);
  expect(after.versions).toEqual(detail.versions); expect(after.comments).toHaveLength(2);
});

test('empty base and absent files remain explicit on each side without borrowing the other version source', async ({ page, request, baseURL }) => {
  const detail = await create(request, baseURL!);
  await page.goto(`./#${detail.revision.id}`); await choose(page, 'Side by side');
  for (const [path, before, after] of [['removed.tex', removed, ''], ['added.tex', '', added], ['empty.tex', '', '']] as const) {
    await page.getByLabel('Source file', { exact: true }).selectOption(path);
    expect(await exactSide(page, 'before')).toBe(before); expect(await exactSide(page, 'after')).toBe(after);
    await choose(page, 'Preview');
    for (const [side, text, number] of [['before', before, 2], ['after', after, 3]] as const) {
      const pane = renderedSide(page, side);
      if (text) {
        await expect(pane.getByRole('region', { name: 'Paper reading preview', exact: true })).toContainText(text.split('\r\n')[0]!);
        expect((await renderedChanges(page, side).allTextContents()).join('')).toContain('appendix');
        await expect(pane.locator(`.paper-preview-change[data-change-kind="${side === 'before' ? 'added' : 'removed'}"]`)).toHaveCount(0);
      }
      else if (path === 'empty.tex') {
        await expect(pane).toContainText(`This file is empty in Version ${number}.`);
        await expect(pane.getByRole('region', { name: 'Paper reading preview', exact: true })).toHaveCount(0);
      }
      else { await expect(pane).toContainText(`absent from Version ${number}`); await expect(pane.getByRole('region', { name: 'Paper reading preview', exact: true })).toHaveCount(0); }
      if (!text) await expect(renderedChanges(page, side)).toHaveCount(0);
    }
    await contained(page); await choose(page, 'Changes');
  }
  await page.getByLabel('Source file', { exact: true }).selectOption('main.tex');
  await page.getByLabel('Base version', { exact: true }).selectOption('0');
  expect(await exactSide(page, 'before')).toBe(''); expect(await exactSide(page, 'after')).toBe(versions[2]);
  await choose(page, 'Preview');
  await expect(renderedSide(page, 'before')).toContainText('Empty base');
  await expect(renderedSide(page, 'before').getByRole('region', { name: 'Paper reading preview', exact: true })).toHaveCount(0);
  await expect(renderedSide(page, 'after')).toContainText('The corrected claim');
  await expect(renderedSide(page, 'after').locator('.paper-preview-change[data-change-kind="added"] .katex annotation')).toHaveText('a^2+b^2\\neq c^2');
  expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${detail.revision.id}`)).versions).toEqual(detail.versions);
});

test('side by side previews and an exact target-side draft reopen offline without publishing source or comments', async ({ page, context, request, baseURL }) => {
  const detail = await create(request, baseURL!), target = detail.versions.find(item => item.number === 3)!;
  await page.goto(`./#${detail.revision.id}`); await choose(page, 'Side by side');
  await sourceSplit(page).getByRole('button', { name: 'Comment on line 8', exact: true }).click();
  const quote = versions[2]!.split('\r\n')[7]!;
  await comment(page).fill('An unsent comment on the corrected mathematical claim.');
  await expect(composer(page).locator('.thread-quotation')).toHaveText(quote);
  await choose(page, 'Preview');
  await expect(comment(page)).toHaveValue('An unsent comment on the corrected mathematical claim.');
  await expect.poll(() => page.evaluate(({ id, version }) => {
    const key = Object.keys(localStorage).find(key => key.endsWith(`:comment-source:${id}:${version}`));
    return key ? JSON.parse(localStorage.getItem(key)!).body : null;
  }, { id: detail.revision.id, version: target.id })).toBe('An unsent comment on the corrected mathematical claim.');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  let writes = 0;
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/api\/revisions\/[^/]+\/(?:comments|review-drafts|versions)(?:\/|$)/.test(new URL(request.url()).pathname)) writes++;
  });
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(panel(page).getByRole('button', { name: 'Side by side', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(renderedSide(page, 'before')).toContainText('The earlier claim');
    await expect(renderedSide(page, 'after')).toContainText('The corrected claim');
    await highlightedClaim(page, 'before', 'earlier'); await highlightedClaim(page, 'after', 'corrected');
    await expect(comment(page)).toHaveValue('An unsent comment on the corrected mathematical claim.');
    await expect(composer(page).locator('.thread-quotation')).toHaveText(quote);
    await expect(page.getByLabel('Comment version', { exact: true })).toHaveValue(target.id);
    expect(await pair(page)).toEqual({ base: '2', target: '3', path: 'main.tex' });
    await choose(page, 'Changes');
    expect(await exactSide(page, 'before')).toBe(versions[1]); expect(await exactSide(page, 'after')).toBe(versions[2]);
    await contained(page);
  } finally { await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); }
  expect(writes).toBe(0);
  const after = await api<RevisionDetail>(request, baseURL!, `/revisions/${detail.revision.id}`);
  expect(after.comments).toEqual([]); expect(after.versions).toEqual(detail.versions);
});

test('saving the next paper version retains the chosen split preview and advances both immutable sides', async ({ page, request, baseURL }) => {
  const detail = await create(request, baseURL!);
  await page.goto(`./#${detail.revision.id}`); await choose(page, 'Side by side'); await choose(page, 'Preview');
  await panel(page).getByRole('button', { name: 'Edit & add version', exact: true }).click();
  const editor = page.locator('.paper-version-editor');
  const finalSource = manuscript('The final claim is $a^2+b^2\\neq c^2$, with a complete explanation.').replace(/\r\n/g, '\n');
  await editor.getByRole('textbox', { name: 'File content', exact: true }).fill(finalSource);
  await editor.getByRole('textbox', { name: 'What changed?', exact: true }).fill('Complete the explanation while retaining the review layout.');
  await editor.getByRole('button', { name: 'Save New Version', exact: true }).click();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('4');
  expect(await pair(page)).toEqual({ base: '3', target: '4', path: 'main.tex' });
  await expect(panel(page).getByRole('button', { name: 'Side by side', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel(page).getByRole('button', { name: 'Preview', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(renderedSide(page, 'before')).toContainText('The corrected claim');
  await expect(renderedSide(page, 'after')).toContainText('The final claim');
  for (const side of ['before', 'after'] as const) {
    await expect(renderedSide(page, side).locator('.katex annotation')).toHaveText('a^2+b^2\\neq c^2');
    await expect(renderedChanges(page, side).locator('.katex')).toHaveCount(0);
  }
  const after = await api<RevisionDetail>(request, baseURL!, `/revisions/${detail.revision.id}`);
  expect(after.versions.filter(item => item.number <= 3)).toEqual(detail.versions);
  expect(after.versions.find(item => item.number === 4)!.files.find(item => item.path === 'main.tex')!.content).toBe(finalSource);
  expect(after.comments).toEqual([]);
});

test('any selected rendered pair highlights nested prose and whole display equations while retaining exact downloads', async ({ page, request, baseURL }, info) => {
  const sources = [
    manuscript('A stable opening remains.\r\n\r\n\\textbf{A \\emph{precise} theorem} follows from $x+1=y$.\r\n\r\n\\[\\frac{1}{2}=q\\]'),
    manuscript('An intermediate draft with a different argument.'),
    manuscript('A stable opening remains.\r\n\r\n\\textbf{A \\emph{rigorous} theorem} follows from $x+1=y$.\r\n\r\n\\[\\frac{3}{4}=q\\]'),
  ];
  const detail = await create(request, baseURL!, sources);
  await page.goto(`./#${detail.revision.id}`); await choose(page, 'Side by side'); await choose(page, 'Preview');
  await page.getByLabel('Base version', { exact: true }).selectOption('1');
  expect(await pair(page)).toEqual({ base: '1', target: '3', path: 'main.tex' });
  for (const [side, kind, adjective, equation, index] of [
    ['before', 'removed', 'precise', '\\frac{1}{2}=q', 0],
    ['after', 'added', 'rigorous', '\\frac{3}{4}=q', 2],
  ] as const) {
    const pane = renderedSide(page, side), changes = renderedChanges(page, side);
    await expect(pane.locator(`strong em .paper-preview-change[data-change-kind="${kind}"]`)).toHaveText(adjective);
    await expect(pane.locator(`.paper-preview-change[data-change-kind="${kind}"] .paper-math-display .katex annotation`)).toHaveText(equation);
    await expect(pane.locator('.paper-math-inline .katex annotation')).toHaveText('x+1=y');
    await expect(changes.locator('.paper-math-inline')).toHaveCount(0);
    const marked = (await changes.allTextContents()).join('');
    expect(marked).not.toContain('stable'); expect(marked).not.toContain('theorem'); expect(marked).not.toContain('follows');
    await expect(pane).not.toContainText('An intermediate draft');
    const download = page.waitForEvent('download');
    await pane.getByRole('button', { name: `Download ${side === 'before' ? 'base' : 'target'} source`, exact: true }).click();
    expect(await readFile((await (await download).path())!, 'utf8')).toBe(sources[index]);
  }
  await contained(page);
  await panel(page).screenshot({ path: info.outputPath('paper-rendered-highlights.png') });
  await choose(page, 'Inline');
  await expect(panel(page).locator('.paper-preview-change')).toHaveCount(0);
  await expect(panel(page).locator('.paper-math-content')).toContainText('rigorous');
  await choose(page, 'Side by side');
  await expect(renderedSide(page, 'before').locator('strong em .paper-preview-change')).toHaveText('precise');
  await expect(renderedSide(page, 'after').locator('strong em .paper-preview-change')).toHaveText('rigorous');
  await choose(page, 'Changes');
  expect(await exactSide(page, 'before')).toBe(sources[0]); expect(await exactSide(page, 'after')).toBe(sources[2]);
  const after = await api<RevisionDetail>(request, baseURL!, `/revisions/${detail.revision.id}`);
  expect(after.versions).toEqual(detail.versions); expect(after.comments).toEqual([]);
});

test('a bounded rendered comparison keeps both complete previews and exact downloads without partial highlights', async ({ page, request, baseURL }) => {
  const bodies = ['baseword', 'targetword'].map(prefix => Array.from({ length: 1100 }, (_, index) => `${prefix}${index}`).join(' '));
  const sources = [manuscript('An initial short draft.'), manuscript(bodies[0]!), manuscript(bodies[1]!)];
  const detail = await create(request, baseURL!, sources);
  await page.goto(`./#${detail.revision.id}`); await choose(page, 'Side by side'); await choose(page, 'Preview');
  const unavailable = panel(page).getByText(/Change highlighting is unavailable for this comparison\./);
  await expect(unavailable).toBeVisible();
  await expect(renderedSplit(page).locator('.paper-preview-change')).toHaveCount(0);
  for (const [side, index] of [['before', 0], ['after', 1]] as const) {
    const pane = renderedSide(page, side);
    await expect(pane.locator('.paper-math-content')).toContainText(bodies[index]!);
    const download = page.waitForEvent('download');
    await pane.getByRole('button', { name: `Download ${side === 'before' ? 'base' : 'target'} source`, exact: true }).click();
    expect(await readFile((await (await download).path())!, 'utf8')).toBe(sources[index + 1]);
  }
  await contained(page);
  await page.getByLabel('Base version', { exact: true }).selectOption('3');
  await expect(unavailable).toHaveCount(0);
  await expect(panel(page).getByText('No visible content changes. Source-only changes appear in Changes.', { exact: true })).toBeVisible();
  await expect(renderedSplit(page).locator('.paper-preview-change')).toHaveCount(0);
  for (const side of ['before', 'after'] as const) await expect(renderedSide(page, side).locator('.paper-math-content')).toContainText(bodies[1]!);
  await page.getByLabel('Base version', { exact: true }).selectOption('2');
  await page.getByLabel('Source file', { exact: true }).selectOption('added.tex');
  await expect(unavailable).toHaveCount(0);
  await expect(panel(page).getByText('Added in target', { exact: true })).toBeVisible();
  expect((await renderedChanges(page, 'after').allTextContents()).join('')).toContain('appendix');
  await expect(renderedChanges(page, 'before')).toHaveCount(0);
  const after = await api<RevisionDetail>(request, baseURL!, `/revisions/${detail.revision.id}`);
  expect(after.versions).toEqual(detail.versions); expect(after.comments).toEqual([]);
});

test('changed macro definitions also highlight later equations and preserve each side rendering context through version switches', async ({ page, request, baseURL }) => {
  const sources = [
    manuscript('A shared definition $\\gdef\\answer{1}$ gives $\\answer$. The common explanation stays.'),
    manuscript('An intermediate draft without equations.'),
    manuscript('A shared definition $\\gdef\\answer{2}$ gives $\\answer$. The common explanation stays.'),
  ];
  const detail = await create(request, baseURL!, sources), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`./#${detail.revision.id}`); await choose(page, 'Side by side'); await choose(page, 'Preview');
  await page.getByLabel('Base version', { exact: true }).selectOption('1');
  const expectContexts = async (before: 1 | 2, after: 1 | 2, changed: boolean) => {
    for (const [side, answer] of [['before', before], ['after', after]] as const) {
      const pane = renderedSide(page, side), equations = pane.locator('.paper-math-inline');
      await expect(equations.locator('.katex annotation')).toHaveText([`\\gdef\\answer{${answer}}`, '\\answer']);
      await expect(equations.nth(1).locator('.katex-html')).toHaveText(String(answer));
      await expect(pane.locator('.paper-math-fallback')).toHaveCount(0);
      const changes = renderedChanges(page, side);
      if (changed) {
        await expect(pane.locator(`.paper-preview-change[data-change-kind="${side === 'before' ? 'removed' : 'added'}"] .katex annotation`)).toHaveText([`\\gdef\\answer{${answer}}`, '\\answer']);
        expect((await changes.allTextContents()).join('')).not.toMatch(/shared definition|gives|common explanation/);
      } else await expect(changes).toHaveCount(0);
    }
    await expect(panel(page).getByText('Unfinished or unsupported equations are shown as source.', { exact: true })).toHaveCount(0);
  };
  await expectContexts(1, 2, true);
  await page.getByLabel('Base version', { exact: true }).selectOption('3');
  await expectContexts(2, 2, false);
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('1');
  await expectContexts(2, 1, true);
  expect(await pair(page)).toEqual({ base: '3', target: '1', path: 'main.tex' });
  await choose(page, 'Changes');
  expect(await exactSide(page, 'before')).toBe(sources[2]); expect(await exactSide(page, 'after')).toBe(sources[0]);
  await contained(page); expect(errors).toEqual([]);
  const after = await api<RevisionDetail>(request, baseURL!, `/revisions/${detail.revision.id}`);
  expect(after.versions).toEqual(detail.versions); expect(after.comments).toEqual([]);
});
