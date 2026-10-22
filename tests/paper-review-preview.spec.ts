import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { RevisionDetail } from '../shared/types';

const source = String.raw`\documentclass{article}
\usepackage{amsmath}
\title{A readable manuscript}
\author{An Author}
\begin{document}
\maketitle
\section{First argument}
The original claim is $x^2 + y^2 = z^2$.
\end{document}
`;
async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> {
  const response = await request.fetch(new URL(`api${path}`, baseURL).href, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { data: body, headers: { 'Idempotency-Key': randomUUID() } }),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}
async function create(request: APIRequestContext, baseURL: string) {
  return api<RevisionDetail>(request, baseURL, '/revisions', {
    kind: 'paper', title: `Readable paper ${randomUUID()}`, summary: 'A complete LaTeX manuscript.',
    testPlan: 'Verify reading previews retain exact immutable source and explicit comparisons.',
    files: [{ path: 'main.tex', content: source }],
  });
}
const panel = (page: Page) => page.locator('.revision-comparison-panel');
const preview = (page: Page) => panel(page).getByRole('region', { name: 'Paper reading preview', exact: true });
const choose = (page: Page, name: string) => panel(page).getByRole('button', { name, exact: true }).click();

test('an initial paper opens in readable preview while source, download and unsent comments stay exact', async ({ page, request, baseURL }, info) => {
  const detail = await create(request, baseURL!);
  await page.goto(`./#${detail.revision.id}`);
  await expect(panel(page).getByRole('button', { name: 'Preview', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(preview(page).getByRole('heading', { name: 'A readable manuscript', exact: true })).toBeVisible();
  await expect(preview(page)).toContainText('An Author');
  await expect(preview(page).locator('.katex')).toHaveCount(1);
  await expect(preview(page)).not.toContainText('\\documentclass');
  await expect(preview(page)).not.toContainText('\\begin{document}');
  await expect(preview(page)).not.toContainText('\\end{document}');
  await expect(panel(page).locator('.literal-diff, .passage-navigation')).toHaveCount(0);
  await expect(panel(page).locator('.comparison-identity')).toHaveText('Version 1 · main.tex · Reading preview');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await panel(page).screenshot({ path: info.outputPath('paper-reading-preview.png') });

  const comment = page.getByLabel('Review comment', { exact: true });
  await comment.fill('Keep this unsent review of the original manuscript.');
  await choose(page, 'Source');
  await expect(page.locator('.selectable-source')).toHaveText(source);
  await choose(page, 'Preview');
  await expect(comment).toHaveValue('Keep this unsent review of the original manuscript.');
  const download = page.waitForEvent('download');
  await panel(page).getByRole('button', { name: 'Download source', exact: true }).click();
  const file = await download;
  expect(await readFile((await file.path())!, 'utf8')).toBe(source);
  expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${detail.revision.id}`)).versions).toEqual(detail.versions);
});

test('paper version comparisons remain literal and preview always follows the explicitly selected immutable target', async ({ page, request, baseURL }) => {
  const created = await create(request, baseURL!);
  const updated = source.replace('The original claim', 'The revised claim');
  await api(request, baseURL!, `/revisions/${created.revision.id}/versions`, {
    expectedVersion: 1, message: 'Clarify the claim', files: [{ path: 'main.tex', content: updated }],
  });
  const before = await api<RevisionDetail>(request, baseURL!, `/revisions/${created.revision.id}`);
  await page.goto(`./#${created.revision.id}`);
  await expect(panel(page).getByRole('button', { name: 'Changes', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel(page).locator('.literal-diff')).toContainText('\\end{document}');
  await expect(preview(page)).toHaveCount(0);
  await choose(page, 'Preview');
  await expect(preview(page)).toContainText('The revised claim');
  await expect(preview(page)).not.toContainText('The original claim');
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('1');
  await expect(preview(page)).toContainText('The original claim');
  await expect(panel(page).locator('.comparison-identity')).toHaveText('Version 1 · main.tex · Reading preview');
  await page.reload();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
  await expect(preview(page)).toContainText('The original claim');
  await expect(preview(page).locator('.katex')).toHaveCount(1);
  expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${created.revision.id}`)).versions).toEqual(before.versions);
});

test('an explicit initial Changes selection is restored and source line comments keep their original anchor', async ({ page, request, baseURL }, info) => {
  const detail = await create(request, baseURL!);
  await page.goto(`./#${detail.revision.id}`);
  await expect(preview(page)).toBeVisible();
  await choose(page, 'Changes');
  await expect(panel(page).locator('.literal-diff')).toContainText(source);
  await expect(panel(page).locator('.literal-diff .active-change')).toHaveCSS('outline-style', 'none');
  await panel(page).screenshot({ path: info.outputPath('paper-source-changes.png') });
  await page.reload();
  await expect(panel(page).getByRole('button', { name: 'Changes', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(preview(page)).toHaveCount(0);
  await choose(page, 'Preview');
  await choose(page, 'Source');
  await page.locator('.passage-line-numbers > button').nth(7).click();
  await page.getByLabel('Review comment', { exact: true }).fill('Check this exact source equation.');
  await page.getByRole('button', { name: 'Add Comment', exact: true }).click();
  await expect(page.getByLabel('Review comment', { exact: true })).toHaveValue('');
  const after = await api<RevisionDetail>(request, baseURL!, `/revisions/${detail.revision.id}`);
  expect(after.comments).toHaveLength(1);
  expect(after.comments[0]).toMatchObject({ versionId: detail.versions[0]!.id, filePath: 'main.tex', line: 8, body: 'Check this exact source equation.' });
  expect(after.versions).toEqual(detail.versions);
});

test('structured paper reading renders theorem environments, custom notation and labeled equations', async ({ page, request }) => {
  // A cold renderer must get its startup allowance before the computation clock.
  await page.route('**/client/paper-math.worker.ts*', async route => {
    await new Promise(resolve => setTimeout(resolve, 2_500));
    await route.continue();
  });
  const source = String.raw`\documentclass{article}
\newtheorem{proposition}{Proposition}
\newcommand{\leftdiv}{\mathrel{\mid_L}}
\title{Permutation cancellation}
\begin{document}\maketitle
\begin{abstract}A readable manuscript.\end{abstract}
\begin{proposition}\label{prop:cancel}Suppose $a\leftdiv mn$.\end{proposition}
\begin{proof}Use Proposition~\ref{prop:cancel}.
\begin{equation}\label{eq:cancel}a\leftdiv n\end{equation}
Equation~\eqref{eq:cancel} is the conclusion.\end{proof}
\end{document}`;
  const response = await request.post('api/revisions', { headers: { 'Idempotency-Key': randomUUID() }, data: {
    kind: 'paper', title: 'Structured manuscript', summary: '',
    testPlan: 'Check reading layout and original source.', files: [{ path: 'main.tex', content: source }],
  } });
  expect(response.ok()).toBe(true);
  const detail = await response.json() as RevisionDetail;
  await page.goto(`./#${detail.revision.id}`);
  const reading = preview(page);
  await expect(reading.locator('.katex')).toHaveCount(2, { timeout: 15_000 });
  await expect(reading.locator('.paper-math-fallback, .paper-math-command')).toHaveCount(0);
  await expect(reading).toContainText('Proposition 1.');
  await expect(reading).toContainText('Use Proposition 1.');
  await expect(reading).toContainText('Equation (1) is the conclusion.');
  await expect(reading).toContainText('Abstract');
  await expect(reading).toContainText('Proof.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await choose(page, 'Source');
  await expect(panel(page)).toContainText('\\newcommand{\\leftdiv}');
});
