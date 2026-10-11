import { test, expect, type APIRequestContext } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { normalizeBasePath } from '../shared/mount';
import type { RevisionDetail } from '../shared/types';
import type { PaperBuildPage, PaperSyncTeX } from '../shared/paper-builds';

async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> { const url = new URL(`api${path}`, baseURL).href; const response = body === undefined ? await request.get(url) : await request.post(url, { data: body }); expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>; }

test('real isolated compiler produces a version-bound PDF with bibliography and source navigation', async ({ page, request, baseURL, context }, info) => {
  test.skip(process.env.E2E_REAL_TEX !== '1', 'Enable E2E_REAL_TEX=1 with the pinned isolated compiler configured to verify a real TeX build.'); test.setTimeout(120_000);
  const files = [{ path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\n\\section{Real compiler manuscript}\n\\input{chapter}\nReference: \\cite{knuth1984}.\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n' }, { path: 'chapter.tex', content: 'This chapter was compiled from its own immutable source file.\n' }, { path: 'references.bib', content: '@book{knuth1984, author={Donald Knuth}, title={The TeXbook}, year={1984}, publisher={Addison Wesley}}\n' }];
  const detail = await api<RevisionDetail>(request, baseURL!, '/revisions', { title: `Real compiler browser verification ${Date.now()}`, kind: 'paper', files }); const id = detail.revision.id;
  await page.goto(`./#${id}`); const panel = page.getByRole('region', { name: 'Paper compilation', exact: true }); await expect(panel.getByRole('button', { name: 'Compile Version 1', exact: true })).toBeEnabled(); await panel.getByRole('button', { name: 'Compile Version 1', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Build for version 1', exact: true }).getByRole('heading', { name: 'Version 1 · Succeeded', exact: true })).toBeVisible({ timeout: 90_000 });
  const history = await api<PaperBuildPage>(request, baseURL!, `/revisions/${id}/paper-builds`), build = history.builds[0]!; expect(build.status).toBe('succeeded'); expect(build.versionId).toBe(detail.versions[0]!.id); expect(build.contentHash).toBe(detail.versions[0]!.contentHash); expect(build.artifacts.map(item => item.kind)).toEqual(expect.arrayContaining(['pdf', 'manifest', 'synctex', 'mapping']));
  const mapping = await api<PaperSyncTeX>(request, baseURL!, `/revisions/${id}/paper-builds/${build.id}/synctex`); expect(mapping.versionId).toBe(build.versionId); expect(mapping.contentHash).toBe(build.contentHash); const chapterPoint = mapping.points.findIndex(point => point.path === 'chapter.tex'); expect(chapterPoint).toBeGreaterThanOrEqual(0);
  // Compare independent PDF text geometry with SyncTeX before relying on the
  // browser highlight. A visible box alone would not prove correct alignment.
  const pdfResponse = await request.get(new URL(`api/revisions/${id}/paper-builds/${build.id}/artifacts/pdf`, baseURL!).href); expect(pdfResponse.ok()).toBe(true);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'); const pdfTask = getDocument({ data: new Uint8Array(await pdfResponse.body()), useWorkerFetch: false, useWasm: false });
  try {
    const document = await pdfTask.promise, mapped = mapping.points[chapterPoint]!, sheet = await document.getPage(mapped.page), text = await sheet.getTextContent();
    const chapter = text.items.find(item => 'str' in item && item.str.includes('chapter'));
    expect(chapter, 'The compiled PDF contains the original chapter text.').toBeTruthy();
    if (chapter && 'str' in chapter) {
      const height = sheet.getViewport({ scale: 1 }).height, left = chapter.transform[4]!, bottom = height - chapter.transform[5]!, right = left + chapter.width, top = bottom - chapter.height;
      const dx = Math.max(mapped.x - right, left - mapped.x - mapped.width, 0), dy = Math.max(mapped.y - bottom, top - mapped.y - mapped.height, 0);
      expect(Math.hypot(dx, dy), 'The selected SyncTeX location overlaps or closely borders the actual chapter text.').toBeLessThanOrEqual(8);
    }
  } finally { await pdfTask.destroy(); }
  await panel.getByRole('button', { name: 'Open PDF Preview' }).click(); let preview = panel.getByRole('region', { name: 'PDF preview for version 1', exact: true }); await preview.getByText('Accessible page text', { exact: true }).click(); await expect(preview.locator('.paper-pdf-text')).toContainText('Real compiler manuscript'); await expect(preview.locator('.paper-pdf-text')).toContainText('The TeXbook');
  await preview.getByLabel('PDF source file', { exact: true }).selectOption('chapter.tex'); await preview.getByLabel('PDF source line', { exact: true }).fill('1'); await preview.getByRole('button', { name: 'Find Source in PDF' }).click(); await expect(preview.locator('.paper-pdf-highlight')).toBeVisible();
  const visualDirectory = `.data/paper-real-visual-qa/${normalizeBasePath(process.env.APP_BASE_PATH) === '/' ? 'root' : 'mounted'}`; await mkdir(visualDirectory, { recursive: true });
  await page.evaluate(() => { const element = document.querySelector('.paper-pdf'); if (element) window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 112); });
  await page.screenshot({ path: `${visualDirectory}/${info.project.name}-preview.png` });
  await preview.locator('.paper-pdf-viewport').screenshot({ path: `${visualDirectory}/${info.project.name}-chapter.png` });
  await preview.getByRole('button', { name: 'Open PDF Location in Original Source' }).click(); await expect(page.locator('.source-passages')).toContainText('This chapter was compiled');
  await context.setOffline(true); await expect(panel.getByRole('button', { name: 'Compile Version 1', exact: true })).toBeDisabled(); await expect(preview.getByRole('img')).toBeVisible(); await context.setOffline(false);
  await api(request, baseURL!, `/revisions/${id}/versions`, { expectedVersion: 1, message: 'New source does not replace the compiled PDF', files: [{ path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\nA newer uncompiled source.\n\\end{document}\n' }] });
  await page.reload(); await page.getByRole('button', { name: 'Show current version', exact: true }).click(); await expect(page.getByLabel('Version to inspect')).toHaveValue('2'); await panel.locator('.paper-build-select').click(); await panel.getByRole('button', { name: 'Open PDF Preview' }).click(); preview = panel.getByRole('region', { name: 'PDF preview for version 1', exact: true }); await preview.getByLabel('PDF source file', { exact: true }).selectOption('chapter.tex'); await preview.getByLabel('PDF source line', { exact: true }).fill('1'); await preview.getByRole('button', { name: 'Find Source in PDF' }).click(); await preview.getByRole('button', { name: 'Open PDF Location in Original Source' }).click(); await expect(page.getByLabel('Version to inspect')).toHaveValue('1'); await expect(page.locator('.source-passages')).toContainText('This chapter was compiled');
  const waiting = page.waitForEvent('download'); await panel.getByRole('button', { name: 'Download PDF', exact: true }).click(); const download = await waiting; const stream = await download.createReadStream(); const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk)); expect(Buffer.concat(chunks).subarray(0, 5).toString()).toBe('%PDF-');
  const after = await api<RevisionDetail>(request, baseURL!, `/revisions/${id}`); expect(after.revision.currentVersion).toBe(2); expect(after.versions[0]!.files).toEqual(files); expect(after.reviews).toEqual([]);
});
